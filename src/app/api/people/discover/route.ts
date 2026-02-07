import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  averageAffinityForIds,
  buildDiscoveryPreferenceProfile,
} from "@/lib/preference-profile";
import { getAlgorithmSettings } from "@/lib/algorithm-settings";
import { getTMDBPersonByName, getTMDBProfileUrl } from "@/lib/api/tmdb";

type DiscoverPersonType = "actor" | "director";

const DEFAULT_LIMIT = 16;
const MAX_LIMIT = 40;
const COLD_START_THRESHOLD = 10;
const DIVERSITY_INJECTION_RATE = 0.15;

function parseLimit(value: string | null): number {
  if (!value) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, parsed));
}

function isColdStartUser(ratedCount: number): boolean {
  return ratedCount < COLD_START_THRESHOLD;
}

function parseExcludedIds(values: string[]): Set<string> {
  const excluded = new Set<string>();
  for (const value of values) {
    for (const id of value.split(",")) {
      const trimmed = id.trim();
      if (trimmed) excluded.add(trimmed);
    }
  }
  return excluded;
}

function normalizeRating(rating: number): number {
  return (rating - 3) / 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const typeParam = req.nextUrl.searchParams.get("type");
  const type: DiscoverPersonType =
    typeParam === "director" ? "director" : "actor";
  const limit = parseLimit(req.nextUrl.searchParams.get("limit"));

  const profile = await buildDiscoveryPreferenceProfile(userId);
  const algorithmSettings = await getAlgorithmSettings();
  const tuning = algorithmSettings.peopleDiscovery;
  const excludedPersonIds = parseExcludedIds(
    req.nextUrl.searchParams.getAll("excludePersonIds")
  );

  const ratedIds =
    type === "actor" ? profile.userRatedActorIds : profile.userRatedDirectorIds;
  for (const ratedId of ratedIds) {
    excludedPersonIds.add(ratedId);
  }

  // Detect cold start for special handling
  const coldStartUser = isColdStartUser(ratedIds.size);

  if (type === "actor") {
    const candidates = await prisma.person.findMany({
      where: {
        id: { notIn: Array.from(excludedPersonIds) },
        moviesCast: { some: {} },
      },
      select: {
        id: true,
        name: true,
        photoUrl: true,
        tmdbId: true,
        moviesCast: {
          select: {
            movie: {
              select: {
                id: true,
                title: true,
                year: true,
                posterUrl: true,
                genres: { select: { genreId: true } },
                studios: { select: { studioId: true } },
                ratings: {
                  where: { userId: { in: profile.householdUserIds } },
                  select: {
                    rating: true,
                    notHeardOf: true,
                  },
                },
              },
            },
          },
          orderBy: { castOrder: "asc" },
          take: 14,
        },
      },
      take: 300,
    });

    const scored = candidates
      .map((person) => {
        const explicitSignal = profile.actorAffinity.get(person.id) ?? 0;

        const movieSignals = person.moviesCast.map(({ movie }) => {
          const movieSignal = profile.movieAffinity.get(movie.id) ?? 0;
          const genreSignal = averageAffinityForIds(
            movie.genres.map((genre) => genre.genreId),
            profile.genreAffinity
          );
          const studioSignal = averageAffinityForIds(
            movie.studios.map((studio) => studio.studioId),
            profile.studioAffinity
          );
          const householdMovieSignal = (() => {
            const ratings = movie.ratings
              .filter((rating) => !rating.notHeardOf && rating.rating !== null)
              .map((rating) => normalizeRating(rating.rating as number));
            if (ratings.length === 0) return 0;
            return ratings.reduce((sum, value) => sum + value, 0) / ratings.length;
          })();

          // COLD START: For new users, rely more on genre and household signals
          return coldStartUser
            ? genreSignal * 0.5 + householdMovieSignal * 0.5
            : movieSignal * 0.45 +
              genreSignal * 0.3 +
              studioSignal * 0.15 +
              householdMovieSignal * 0.1;
        });

        const movieSignal =
          movieSignals.length > 0
            ? movieSignals.reduce((sum, value) => sum + value, 0) / movieSignals.length
            : 0;

        const prominenceSignal = clamp(person.moviesCast.length / 12, 0, 1);
        const noveltySignal = 1;
        const discoverySignal = (prominenceSignal * 0.55 + noveltySignal * 0.45) * 2 - 1;

        // COLD START: Higher exploration for new users, show prominent/popular actors
        const effectiveExplorationFactor = coldStartUser
          ? Math.max(0.7, profile.explorationFactor)
          : profile.explorationFactor;

        // ACTIVE LEARNING: Bonus for actors in underexplored genres
        const genreExplorationBonus = person.moviesCast.some(({ movie }) =>
          movie.genres.some((g) => !profile.genreAffinity.has(g.genreId))
        )
          ? 0.1
          : 0;

        const score =
          (explicitSignal * 0.45 + movieSignal * 0.55) *
            tuning.preferenceWeight *
            (1 - effectiveExplorationFactor) +
          discoverySignal *
            tuning.discoveryWeight *
            effectiveExplorationFactor +
          genreExplorationBonus +
          Math.random() * tuning.randomJitter;

        // Collect genres for diversity tracking
        const genres = new Set<string>();
        person.moviesCast.forEach(({ movie }) =>
          movie.genres.forEach((g) => genres.add(g.genreId))
        );

        return {
          id: person.id,
          name: person.name,
          photoUrl: person.photoUrl,
          tmdbId: person.tmdbId,
          knownFor: "acting",
          sampleMovies: person.moviesCast
            .slice(0, 5)
            .map((item) => ({
              title: item.movie.title,
              year: item.movie.year,
              posterUrl: item.movie.posterUrl,
            })),
          genres: Array.from(genres),
          score,
        };
      })
      .sort((a, b) => b.score - a.score);

    // DIVERSITY INJECTION: Ensure variety in actor genres
    const diverseResults: typeof scored = [];
    const usedGenres = new Set<string>();
    const diversitySlots = Math.floor(limit * DIVERSITY_INJECTION_RATE);
    const mainSlots = limit - diversitySlots;

    for (const person of scored) {
      if (diverseResults.length >= mainSlots) break;
      diverseResults.push(person);
      person.genres.forEach((g) => usedGenres.add(g));
    }

    for (const person of scored) {
      if (diverseResults.length >= limit) break;
      if (diverseResults.some((r) => r.id === person.id)) continue;
      if (person.genres.some((g) => !usedGenres.has(g))) {
        diverseResults.push(person);
        person.genres.forEach((g) => usedGenres.add(g));
      }
    }

    for (const person of scored) {
      if (diverseResults.length >= limit) break;
      if (!diverseResults.some((r) => r.id === person.id)) {
        diverseResults.push(person);
      }
    }

    const finalScored = diverseResults.slice(0, limit);

    // Fetch TMDB photos for people without photos
    const peopleNeedingPhotos = finalScored.filter((p) => !p.photoUrl).slice(0, 5);
    for (const person of peopleNeedingPhotos) {
      try {
        const tmdbPerson = await getTMDBPersonByName(person.name);
        if (tmdbPerson?.profile_path) {
          const photoUrl = getTMDBProfileUrl(tmdbPerson.profile_path);
          if (photoUrl) {
            person.photoUrl = photoUrl;
            // Update in DB for future requests
            await prisma.person.update({
              where: { id: person.id },
              data: {
                photoUrl,
                tmdbId: person.tmdbId || tmdbPerson.id.toString(),
              },
            });
          }
        }
      } catch {
        // Ignore errors
      }
    }

    return NextResponse.json(
      finalScored.map((person) => ({
        id: person.id,
        name: person.name,
        photoUrl: person.photoUrl,
        knownFor: person.knownFor,
        sampleMovies: person.sampleMovies,
      }))
    );
  }

  const candidates = await prisma.person.findMany({
    where: {
      id: { notIn: Array.from(excludedPersonIds) },
      moviesCrew: {
        some: { job: "Director" },
      },
    },
    select: {
      id: true,
      name: true,
      photoUrl: true,
      tmdbId: true,
      moviesCrew: {
        where: { job: "Director" },
        select: {
          movie: {
            select: {
              id: true,
              title: true,
              year: true,
              posterUrl: true,
              genres: { select: { genreId: true } },
              studios: { select: { studioId: true } },
              ratings: {
                where: { userId: { in: profile.householdUserIds } },
                select: {
                  rating: true,
                  notHeardOf: true,
                },
              },
            },
          },
        },
        take: 14,
      },
    },
    take: 220,
  });

  const directorScored = candidates
    .map((person) => {
      const explicitSignal = profile.directorAffinity.get(person.id) ?? 0;

      const movieSignals = person.moviesCrew.map(({ movie }) => {
        const movieSignal = profile.movieAffinity.get(movie.id) ?? 0;
        const genreSignal = averageAffinityForIds(
          movie.genres.map((genre) => genre.genreId),
          profile.genreAffinity
        );
        const studioSignal = averageAffinityForIds(
          movie.studios.map((studio) => studio.studioId),
          profile.studioAffinity
        );
        const householdMovieSignal = (() => {
          const ratings = movie.ratings
            .filter((rating) => !rating.notHeardOf && rating.rating !== null)
            .map((rating) => normalizeRating(rating.rating as number));
          if (ratings.length === 0) return 0;
          return ratings.reduce((sum, value) => sum + value, 0) / ratings.length;
        })();

        // COLD START: For new users, rely more on genre and household signals
        return coldStartUser
          ? genreSignal * 0.5 + householdMovieSignal * 0.5
          : movieSignal * 0.45 +
            genreSignal * 0.3 +
            studioSignal * 0.15 +
            householdMovieSignal * 0.1;
      });

      const movieSignal =
        movieSignals.length > 0
          ? movieSignals.reduce((sum, value) => sum + value, 0) / movieSignals.length
          : 0;

      const prominenceSignal = clamp(person.moviesCrew.length / 10, 0, 1);
      const noveltySignal = 1;
      const discoverySignal = (prominenceSignal * 0.55 + noveltySignal * 0.45) * 2 - 1;

      // COLD START: Higher exploration for new users
      const effectiveExplorationFactor = coldStartUser
        ? Math.max(0.7, profile.explorationFactor)
        : profile.explorationFactor;

      // ACTIVE LEARNING: Bonus for directors in underexplored genres
      const genreExplorationBonus = person.moviesCrew.some(({ movie }) =>
        movie.genres.some((g) => !profile.genreAffinity.has(g.genreId))
      )
        ? 0.1
        : 0;

      const score =
        (explicitSignal * 0.45 + movieSignal * 0.55) *
          tuning.preferenceWeight *
          (1 - effectiveExplorationFactor) +
        discoverySignal * tuning.discoveryWeight * effectiveExplorationFactor +
        genreExplorationBonus +
        Math.random() * tuning.randomJitter;

      // Collect genres for diversity tracking
      const genres = new Set<string>();
      person.moviesCrew.forEach(({ movie }) =>
        movie.genres.forEach((g) => genres.add(g.genreId))
      );

      return {
        id: person.id,
        name: person.name,
        photoUrl: person.photoUrl,
        tmdbId: person.tmdbId,
        knownFor: "directing",
        sampleMovies: person.moviesCrew
          .slice(0, 5)
          .map((item) => ({
            title: item.movie.title,
            year: item.movie.year,
            posterUrl: item.movie.posterUrl,
          })),
        genres: Array.from(genres),
        score,
      };
    })
    .sort((a, b) => b.score - a.score);

  // DIVERSITY INJECTION for directors
  const directorDiverseResults: typeof directorScored = [];
  const directorUsedGenres = new Set<string>();
  const directorDiversitySlots = Math.floor(limit * DIVERSITY_INJECTION_RATE);
  const directorMainSlots = limit - directorDiversitySlots;

  for (const person of directorScored) {
    if (directorDiverseResults.length >= directorMainSlots) break;
    directorDiverseResults.push(person);
    person.genres.forEach((g) => directorUsedGenres.add(g));
  }

  for (const person of directorScored) {
    if (directorDiverseResults.length >= limit) break;
    if (directorDiverseResults.some((r) => r.id === person.id)) continue;
    if (person.genres.some((g) => !directorUsedGenres.has(g))) {
      directorDiverseResults.push(person);
      person.genres.forEach((g) => directorUsedGenres.add(g));
    }
  }

  for (const person of directorScored) {
    if (directorDiverseResults.length >= limit) break;
    if (!directorDiverseResults.some((r) => r.id === person.id)) {
      directorDiverseResults.push(person);
    }
  }

  const directorFinalScored = directorDiverseResults.slice(0, limit);

  // Fetch TMDB photos for people without photos
  const directorPeopleNeedingPhotos = directorFinalScored.filter((p) => !p.photoUrl).slice(0, 5);
  for (const person of directorPeopleNeedingPhotos) {
    try {
      const tmdbPerson = await getTMDBPersonByName(person.name);
      if (tmdbPerson?.profile_path) {
        const photoUrl = getTMDBProfileUrl(tmdbPerson.profile_path);
        if (photoUrl) {
          person.photoUrl = photoUrl;
          // Update in DB for future requests
          await prisma.person.update({
            where: { id: person.id },
            data: {
              photoUrl,
              tmdbId: person.tmdbId || tmdbPerson.id.toString(),
            },
          });
        }
      }
    } catch {
      // Ignore errors
    }
  }

  return NextResponse.json(
    directorFinalScored.map((person) => ({
      id: person.id,
      name: person.name,
      photoUrl: person.photoUrl,
      knownFor: person.knownFor,
      sampleMovies: person.sampleMovies,
    }))
  );
}
