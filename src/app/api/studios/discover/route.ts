import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  averageAffinityForIds,
  buildDiscoveryPreferenceProfile,
} from "@/lib/preference-profile";
import { getAlgorithmSettings } from "@/lib/algorithm-settings";

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

  const scored = candidates
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

        return (
          movieSignal * 0.4 +
          genreSignal * 0.2 +
          actorSignal * 0.2 +
          directorSignal * 0.1 +
          householdMovieSignal * 0.1
        );
      });

      const movieSignal =
        movieSignals.length > 0
          ? movieSignals.reduce((sum, value) => sum + value, 0) / movieSignals.length
          : 0;

      const prominenceSignal = clamp(studio.movies.length / 14, 0, 1);
      const noveltySignal = 1;
      const discoverySignal = (prominenceSignal * 0.55 + noveltySignal * 0.45) * 2 - 1;

      const score =
        (explicitSignal * 0.45 + movieSignal * 0.55) *
          tuning.preferenceWeight *
          (1 - profile.explorationFactor) +
        discoverySignal * tuning.discoveryWeight * profile.explorationFactor +
        Math.random() * tuning.randomJitter;

      return {
        id: studio.id,
        name: studio.name,
        slug: studio.slug,
        sampleMovies: studio.movies
          .map((item) => item.movie)
          .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
          .slice(0, 3)
          .map((movie) => ({
            title: movie.title,
            posterUrl: movie.posterUrl,
            year: movie.year,
            overview: movie.overview,
            directors: movie.crew.map((crewMember) => crewMember.person.name),
          })),
        score,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((studio) => ({
      id: studio.id,
      name: studio.name,
      slug: studio.slug,
      sampleMovies: studio.sampleMovies,
    }));

  return NextResponse.json(scored);
}
