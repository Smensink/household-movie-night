import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  averageAffinityForIds,
  buildDiscoveryPreferenceProfile,
} from "@/lib/preference-profile";
import { getAlgorithmSettings } from "@/lib/algorithm-settings";
import { getHighResPosterUrl } from "@/lib/api/omdb";
import { fetchAndPersistMoviePoster } from "@/lib/api/tmdb";

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

  const limit = parseLimit(req.nextUrl.searchParams.get("limit"));
  const profile = await buildDiscoveryPreferenceProfile(userId);
  const algorithmSettings = await getAlgorithmSettings();
  const tuning = algorithmSettings.studioDiscovery;

  const excludedStudioIds = parseExcludedIds(
    req.nextUrl.searchParams.getAll("excludeStudioIds")
  );
  for (const ratedId of profile.userRatedStudioIds) {
    excludedStudioIds.add(ratedId);
  }

  // Detect cold start for special handling
  const coldStartUser = isColdStartUser(profile.userRatedStudioIds.size);

  const candidates = await prisma.studio.findMany({
    where: {
      id: { notIn: Array.from(excludedStudioIds) },
    },
    select: {
      id: true,
      name: true,
      slug: true,
      movies: {
        select: {
          movie: {
            select: {
              id: true,
              title: true,
              year: true,
              posterUrl: true,
              overview: true,
              popularity: true,
              imdbId: true,
              genres: { select: { genreId: true } },
              cast: { select: { personId: true }, take: 4, orderBy: { castOrder: "asc" } },
              crew: {
                where: { job: "Director" },
                select: { personId: true, person: { select: { name: true } } },
                take: 2,
              },
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
        take: 16,
      },
    },
    take: 180,
  });

  // Try to fetch missing posters for up to 5 movies per request (to avoid slowing down too much)
  let posterFetchCount = 0;
  const MAX_POSTER_FETCHES = 5;

  for (const studio of candidates) {
    if (posterFetchCount >= MAX_POSTER_FETCHES) break;

    for (const { movie } of studio.movies) {
      if (posterFetchCount >= MAX_POSTER_FETCHES) break;
      if (movie.posterUrl && movie.posterUrl !== "N/A") continue;

      // Fetch missing poster
      const newPosterUrl = await fetchAndPersistMoviePoster(
        movie.id,
        movie.imdbId,
        movie.title,
        movie.year
      );
      if (newPosterUrl) {
        (movie as { posterUrl: string | null }).posterUrl = newPosterUrl;
        posterFetchCount++;
      }
    }
  }

  // Filter to studios with at least one movie with a poster (after fetch attempts)
  const candidatesWithContent = candidates.filter((studio) =>
    studio.movies.some(
      ({ movie }) => movie.posterUrl && movie.posterUrl !== "N/A"
    )
  );

  const scored = candidatesWithContent
    .map((studio) => {
      const explicitSignal = profile.studioAffinity.get(studio.id) ?? 0;

      const movieSignals = studio.movies.map(({ movie }) => {
        const movieSignal = profile.movieAffinity.get(movie.id) ?? 0;
        const genreSignal = averageAffinityForIds(
          movie.genres.map((genre) => genre.genreId),
          profile.genreAffinity
        );
        const actorSignal = averageAffinityForIds(
          movie.cast.map((castMember) => castMember.personId),
          profile.actorAffinity
        );
        const directorSignal = averageAffinityForIds(
          movie.crew.map((crewMember) => crewMember.personId),
          profile.directorAffinity
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
          : movieSignal * 0.4 +
            genreSignal * 0.2 +
            actorSignal * 0.2 +
            directorSignal * 0.1 +
            householdMovieSignal * 0.1;
      });

      const movieSignal =
        movieSignals.length > 0
          ? movieSignals.reduce((sum, value) => sum + value, 0) / movieSignals.length
          : 0;

      const prominenceSignal = clamp(studio.movies.length / 14, 0, 1);
      const noveltySignal = 1;
      const discoverySignal = (prominenceSignal * 0.55 + noveltySignal * 0.45) * 2 - 1;

      // COLD START: Higher exploration for new users, show prominent studios
      const effectiveExplorationFactor = coldStartUser
        ? Math.max(0.7, profile.explorationFactor)
        : profile.explorationFactor;

      // ACTIVE LEARNING: Bonus for studios with underexplored genres
      const genreExplorationBonus = studio.movies.some(({ movie }) =>
        movie.genres.some((g) => !profile.genreAffinity.has(g.genreId))
      )
        ? 0.1
        : 0;

      // Collect genres for diversity tracking
      const genres = new Set<string>();
      studio.movies.forEach(({ movie }) =>
        movie.genres.forEach((g) => genres.add(g.genreId))
      );

      const score =
        (explicitSignal * 0.45 + movieSignal * 0.55) *
          tuning.preferenceWeight *
          (1 - effectiveExplorationFactor) +
        discoverySignal * tuning.discoveryWeight * effectiveExplorationFactor +
        genreExplorationBonus +
        Math.random() * tuning.randomJitter;

      // Prioritize movies with posters, then by popularity
      const moviesWithPosters = studio.movies
        .map((item) => item.movie)
        .filter((movie) => movie.posterUrl && movie.posterUrl !== "N/A")
        .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));

      const moviesWithoutPosters = studio.movies
        .map((item) => item.movie)
        .filter((movie) => !movie.posterUrl || movie.posterUrl === "N/A")
        .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));

      const sortedMovies = [...moviesWithPosters, ...moviesWithoutPosters].slice(0, 5);

      return {
        id: studio.id,
        name: studio.name,
        slug: studio.slug,
        sampleMovies: sortedMovies.map((movie) => ({
          title: movie.title,
          posterUrl: getHighResPosterUrl(movie.posterUrl) || movie.posterUrl,
          year: movie.year,
          overview: movie.overview,
          directors: movie.crew.map((crewMember) => crewMember.person.name),
        })),
        genres: Array.from(genres),
        score,
      };
    })
    .sort((a, b) => b.score - a.score);

  // DIVERSITY INJECTION: Ensure variety in studio genres
  const diverseResults: typeof scored = [];
  const usedGenres = new Set<string>();
  const diversitySlots = Math.floor(limit * DIVERSITY_INJECTION_RATE);
  const mainSlots = limit - diversitySlots;

  for (const studio of scored) {
    if (diverseResults.length >= mainSlots) break;
    diverseResults.push(studio);
    studio.genres.forEach((g) => usedGenres.add(g));
  }

  for (const studio of scored) {
    if (diverseResults.length >= limit) break;
    if (diverseResults.some((r) => r.id === studio.id)) continue;
    if (studio.genres.some((g) => !usedGenres.has(g))) {
      diverseResults.push(studio);
      studio.genres.forEach((g) => usedGenres.add(g));
    }
  }

  for (const studio of scored) {
    if (diverseResults.length >= limit) break;
    if (!diverseResults.some((r) => r.id === studio.id)) {
      diverseResults.push(studio);
    }
  }

  const finalResults = diverseResults
    .slice(0, limit)
    .map((studio) => ({
      id: studio.id,
      name: studio.name,
      slug: studio.slug,
      sampleMovies: studio.sampleMovies,
    }));

  return NextResponse.json(finalResults);
}
