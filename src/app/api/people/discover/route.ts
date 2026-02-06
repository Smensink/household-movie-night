import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  averageAffinityForIds,
  buildDiscoveryPreferenceProfile,
} from "@/lib/preference-profile";
import { getAlgorithmSettings } from "@/lib/algorithm-settings";

type DiscoverPersonType = "actor" | "director";

const DEFAULT_LIMIT = 16;
const MAX_LIMIT = 40;

function parseLimit(value: string | null): number {
  if (!value) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, parsed));
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

  if (type === "actor") {
    const candidates = await prisma.person.findMany({
      where: {
        id: { notIn: Array.from(excludedPersonIds) },
        moviesCast: { some: {} },
      },
      select: {
        id: true,
        name: true,
        moviesCast: {
          select: {
            movie: {
              select: {
                id: true,
                title: true,
                year: true,
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

          return (
            movieSignal * 0.45 +
            genreSignal * 0.3 +
            studioSignal * 0.15 +
            householdMovieSignal * 0.1
          );
        });

        const movieSignal =
          movieSignals.length > 0
            ? movieSignals.reduce((sum, value) => sum + value, 0) / movieSignals.length
            : 0;

        const prominenceSignal = clamp(person.moviesCast.length / 12, 0, 1);
        const noveltySignal = 1;
        const discoverySignal = (prominenceSignal * 0.55 + noveltySignal * 0.45) * 2 - 1;

        const score =
          (explicitSignal * 0.45 + movieSignal * 0.55) *
            tuning.preferenceWeight *
            (1 - profile.explorationFactor) +
          discoverySignal *
            tuning.discoveryWeight *
            profile.explorationFactor +
          Math.random() * tuning.randomJitter;

        return {
          id: person.id,
          name: person.name,
          knownFor: "acting",
          sampleMovies: person.moviesCast
            .map((item) => item.movie.title)
            .filter(Boolean)
            .slice(0, 3),
          score,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((person) => ({
        id: person.id,
        name: person.name,
        knownFor: person.knownFor,
        sampleMovies: person.sampleMovies,
      }));

    return NextResponse.json(scored);
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
      moviesCrew: {
        where: { job: "Director" },
        select: {
          movie: {
            select: {
              id: true,
              title: true,
              year: true,
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

  const scored = candidates
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

        return (
          movieSignal * 0.45 +
          genreSignal * 0.3 +
          studioSignal * 0.15 +
          householdMovieSignal * 0.1
        );
      });

      const movieSignal =
        movieSignals.length > 0
          ? movieSignals.reduce((sum, value) => sum + value, 0) / movieSignals.length
          : 0;

      const prominenceSignal = clamp(person.moviesCrew.length / 10, 0, 1);
      const noveltySignal = 1;
      const discoverySignal = (prominenceSignal * 0.55 + noveltySignal * 0.45) * 2 - 1;

      const score =
        (explicitSignal * 0.45 + movieSignal * 0.55) *
          tuning.preferenceWeight *
          (1 - profile.explorationFactor) +
        discoverySignal * tuning.discoveryWeight * profile.explorationFactor +
        Math.random() * tuning.randomJitter;

      return {
        id: person.id,
        name: person.name,
        knownFor: "directing",
        sampleMovies: person.moviesCrew
          .map((item) => item.movie.title)
          .filter(Boolean)
          .slice(0, 3),
        score,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((person) => ({
      id: person.id,
      name: person.name,
      knownFor: person.knownFor,
      sampleMovies: person.sampleMovies,
    }));

  return NextResponse.json(scored);
}
