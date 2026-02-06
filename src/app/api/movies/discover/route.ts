import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getBoxOfficeMovies, getPopularMovies, getTrendingMovies } from "@/lib/api/trakt";
import { getOMDBMovie } from "@/lib/api/omdb";
import { prisma } from "@/lib/prisma";
import {
  extractMovieMetadataFromRelations,
  syncMovieMetadataFromOMDB,
} from "@/lib/movie-metadata";
import {
  averageAffinityForIds,
  buildDiscoveryPreferenceProfile,
} from "@/lib/preference-profile";
import { getAlgorithmSettings } from "@/lib/algorithm-settings";

type DiscoverSource = "trending" | "popular" | "boxoffice" | "library";

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 30;
const SOURCE_FETCH_LIMIT = 40;

function parseOptionalInt(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/\d+/);
  if (!match) return null;
  const parsed = Number.parseInt(match[0], 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseLimit(value: string | null): number {
  if (!value) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, parsed));
}

function parseExcludedMovieIds(values: string[]): Set<string> {
  const excluded = new Set<string>();
  for (const value of values) {
    for (const id of value.split(",")) {
      const trimmed = id.trim();
      if (trimmed) {
        excluded.add(trimmed);
      }
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

function getSourcePreferenceWeights(pref: string): Record<DiscoverSource, number> {
  if (pref === "trending") {
    return { trending: 1, popular: 0.4, boxoffice: 0.7, library: 0.2 };
  }
  if (pref === "popular") {
    return { trending: 0.4, popular: 1, boxoffice: 0.6, library: 0.2 };
  }
  if (pref === "new_releases") {
    return { trending: 0.8, popular: 0.5, boxoffice: 1, library: 0.1 };
  }
  if (pref === "top_rated") {
    return { trending: 0.4, popular: 0.7, boxoffice: 0.4, library: 0.9 };
  }

  return { trending: 0.8, popular: 0.8, boxoffice: 0.6, library: 0.4 };
}

function mergeUnique(values: string[], extras: string[], limit: number): string[] {
  return Array.from(new Set([...values, ...extras])).slice(0, limit);
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
  const tuning = algorithmSettings.movieDiscovery;

  const excludedMovieIds = parseExcludedMovieIds(
    req.nextUrl.searchParams.getAll("excludeMovieIds")
  );
  for (const ratedMovieId of profile.userRatedMovieIds) {
    excludedMovieIds.add(ratedMovieId);
  }

  const userRatedMovies = await prisma.movie.findMany({
    where: {
      ratings: {
        some: {
          userId: session.user.id,
        },
      },
    },
    select: { imdbId: true },
  });
  const ratedImdbIds = new Set(
    userRatedMovies.map((movie) => movie.imdbId).filter((id): id is string => Boolean(id))
  );

  const [trending, popular, boxOffice] = await Promise.all([
    getTrendingMovies(SOURCE_FETCH_LIMIT),
    getPopularMovies(SOURCE_FETCH_LIMIT),
    getBoxOfficeMovies(),
  ]);

  const traktPool: Array<{
    source: DiscoverSource;
    sourceStrength: number;
    movie: {
      title: string;
      year: number;
      ids: { imdb?: string; tmdb?: number; slug?: string };
    };
  }> = [
    ...trending.map((item) => ({
      source: "trending" as const,
      sourceStrength: clamp(item.watchers / 250, 0, 1),
      movie: item.movie,
    })),
    ...popular.map((item, index) => ({
      source: "popular" as const,
      sourceStrength: clamp((SOURCE_FETCH_LIMIT - index) / SOURCE_FETCH_LIMIT, 0, 1),
      movie: item,
    })),
    ...boxOffice.map((item) => ({
      source: "boxoffice" as const,
      sourceStrength: clamp(item.revenue / 100_000_000, 0, 1),
      movie: item.movie,
    })),
  ];

  const sourceByMovieId = new Map<string, { source: DiscoverSource; strength: number }>();
  const candidateMovieIds = new Set<string>();
  const seenImdbIds = new Set<string>();

  const processLimit = Math.max(limit * 4, 40);
  for (const candidate of traktPool) {
    if (candidateMovieIds.size >= processLimit) break;

    const imdbId = candidate.movie.ids?.imdb;
    if (!imdbId || seenImdbIds.has(imdbId) || ratedImdbIds.has(imdbId)) continue;
    seenImdbIds.add(imdbId);

    const existingMovie = await prisma.movie.findUnique({
      where: { imdbId },
      include: {
        cast: {
          include: { person: { select: { name: true } } },
          orderBy: { castOrder: "asc" },
          take: 3,
        },
        crew: {
          where: { job: "Director" },
          include: { person: { select: { name: true } } },
          take: 3,
        },
        studios: {
          include: { studio: { select: { name: true } } },
          take: 2,
        },
      },
    });

    if (existingMovie && excludedMovieIds.has(existingMovie.id)) {
      continue;
    }

    const relationMetadata = extractMovieMetadataFromRelations(existingMovie);
    const needsOmdbDetails =
      !existingMovie ||
      !existingMovie.posterUrl ||
      !existingMovie.overview ||
      existingMovie.runtime === null ||
      relationMetadata.actors.length === 0 ||
      relationMetadata.directors.length === 0 ||
      relationMetadata.studios.length === 0;

    const details = needsOmdbDetails ? await getOMDBMovie(imdbId) : null;

    const year =
      candidate.movie.year || parseOptionalInt(details?.Year) || existingMovie?.year || null;
    const runtime = parseOptionalInt(details?.Runtime) ?? existingMovie?.runtime ?? null;
    const era = getEra(year) || existingMovie?.era || null;

    const persisted = await prisma.movie.upsert({
      where: { imdbId },
      create: {
        imdbId,
        tmdbId: candidate.movie.ids?.tmdb?.toString() || null,
        traktSlug: candidate.movie.ids?.slug || null,
        title: candidate.movie.title,
        year,
        posterUrl:
          details?.Poster && details.Poster !== "N/A"
            ? details.Poster
            : existingMovie?.posterUrl || null,
        overview: details?.Plot || existingMovie?.overview || null,
        runtime,
        era,
      },
      update: {
        title: candidate.movie.title,
        ...(candidate.movie.ids?.tmdb && { tmdbId: candidate.movie.ids.tmdb.toString() }),
        ...(candidate.movie.ids?.slug && { traktSlug: candidate.movie.ids.slug }),
        ...(year !== null && { year }),
        ...(details?.Poster && details.Poster !== "N/A" && { posterUrl: details.Poster }),
        ...(details?.Plot && { overview: details.Plot }),
        ...(runtime !== null && { runtime }),
        ...(era && { era }),
      },
      select: { id: true },
    });

    if (details) {
      const shouldSyncMetadata =
        relationMetadata.actors.length === 0 ||
        relationMetadata.directors.length === 0 ||
        relationMetadata.studios.length === 0;
      if (shouldSyncMetadata) {
        await syncMovieMetadataFromOMDB(persisted.id, details);
      }
    }

    if (excludedMovieIds.has(persisted.id)) {
      continue;
    }

    candidateMovieIds.add(persisted.id);
    const existingSource = sourceByMovieId.get(persisted.id);
    if (!existingSource || candidate.sourceStrength > existingSource.strength) {
      sourceByMovieId.set(persisted.id, {
        source: candidate.source,
        strength: candidate.sourceStrength,
      });
    }
  }

  if (candidateMovieIds.size < limit * 2) {
    const localFallback = await prisma.movie.findMany({
      where: {
        id: { notIn: Array.from(excludedMovieIds) },
      },
      orderBy: [{ updatedAt: "desc" }],
      select: { id: true },
      take: limit * 4,
    });

    for (const movie of localFallback) {
      if (candidateMovieIds.size >= processLimit) break;
      if (excludedMovieIds.has(movie.id)) continue;
      candidateMovieIds.add(movie.id);
      if (!sourceByMovieId.has(movie.id)) {
        sourceByMovieId.set(movie.id, { source: "library", strength: 0.5 });
      }
    }
  }

  const candidateMovies = await prisma.movie.findMany({
    where: {
      id: { in: Array.from(candidateMovieIds), notIn: Array.from(excludedMovieIds) },
    },
    include: {
      genres: { select: { genreId: true } },
      cast: {
        select: {
          personId: true,
          castOrder: true,
          person: { select: { name: true } },
        },
        orderBy: { castOrder: "asc" },
        take: 5,
      },
      crew: {
        where: { job: "Director" },
        select: {
          personId: true,
          job: true,
          person: { select: { name: true } },
        },
        take: 3,
      },
      studios: {
        select: {
          studioId: true,
          studio: { select: { name: true } },
        },
        take: 3,
      },
      ratings: {
        where: { userId: { in: profile.householdUserIds } },
        select: {
          userId: true,
          rating: true,
          notHeardOf: true,
          hasSeen: true,
        },
      },
      plexAvailability: true,
      radarrSync: true,
    },
  });

  const sourcePreferenceWeights = getSourcePreferenceWeights(profile.discoverySourcePref);

  const scored = candidateMovies
    .map((movie) => {
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
      const studioSignal = averageAffinityForIds(
        movie.studios.map((studio) => studio.studioId),
        profile.studioAffinity
      );
      const movieSignal = profile.movieAffinity.get(movie.id) ?? 0;

      const explicitRatings = movie.ratings
        .filter((rating) => !rating.notHeardOf && rating.rating !== null)
        .map((rating) => normalizeRating(rating.rating as number));
      const householdRatingSignal =
        explicitRatings.length > 0
          ? explicitRatings.reduce((sum, value) => sum + value, 0) / explicitRatings.length
          : 0;

      const preferenceSignal =
        genreSignal * 0.3 +
        actorSignal * 0.2 +
        directorSignal * 0.15 +
        studioSignal * 0.15 +
        movieSignal * 0.15 +
        householdRatingSignal * 0.05;

      const sourceInfo = sourceByMovieId.get(movie.id) ?? {
        source: "library" as const,
        strength: 0.5,
      };

      const actorFamiliarity =
        movie.cast.length === 0
          ? 0
          : movie.cast.filter((castMember) => profile.userRatedActorIds.has(castMember.personId))
              .length / movie.cast.length;
      const directorFamiliarity =
        movie.crew.length === 0
          ? 0
          : movie.crew.filter((crewMember) => profile.userRatedDirectorIds.has(crewMember.personId))
              .length / movie.crew.length;
      const studioFamiliarity =
        movie.studios.length === 0
          ? 0
          : movie.studios.filter((studio) => profile.userRatedStudioIds.has(studio.studioId))
              .length / movie.studios.length;

      const noveltySignal =
        1 - (actorFamiliarity * 0.5 + directorFamiliarity * 0.2 + studioFamiliarity * 0.3);
      const qualitySignal =
        clamp((movie.voteAverage ?? 0) / 10, 0, 1) * 0.6 +
        clamp((movie.popularity ?? 0) / 100, 0, 1) * 0.4;
      const sourceSignal = sourcePreferenceWeights[sourceInfo.source] * 0.65 + sourceInfo.strength * 0.35;

      const userRating = movie.ratings.find((rating) => rating.userId === userId);
      const unseenBonus = userRating?.hasSeen ? -0.35 : 0.15;

      const discoveryWeightsTotal =
        tuning.noveltyInfluence + tuning.qualityInfluence + tuning.sourceInfluence;
      const discoveryBase =
        discoveryWeightsTotal > 0
          ? (noveltySignal * tuning.noveltyInfluence +
              qualitySignal * tuning.qualityInfluence +
              sourceSignal * tuning.sourceInfluence) /
            discoveryWeightsTotal
          : (noveltySignal + qualitySignal + sourceSignal) / 3;
      const discoverySignal = discoveryBase * 2 - 1 + unseenBonus;

      const strongDislikes = movie.ratings.filter(
        (rating) => !rating.notHeardOf && rating.rating !== null && rating.rating <= 2
      ).length;
      const dislikePenalty =
        strongDislikes > 0 ? strongDislikes * tuning.dislikePenalty : 0;

      const availabilitySignal =
        movie.radarrSync?.available || movie.plexAvailability?.available ? 1 : 0;

      const score =
        preferenceSignal *
          tuning.preferenceWeight *
          (1 - profile.explorationFactor) +
        discoverySignal *
          tuning.discoveryWeight *
          profile.explorationFactor +
        availabilitySignal * tuning.availabilityBonus +
        dislikePenalty +
        Math.random() * tuning.randomJitter;

      const relationMetadata = extractMovieMetadataFromRelations(movie);
      const omdbMetadata = {
        actors: movie.cast.map((member) => member.person.name).filter(Boolean),
        directors: movie.crew.map((member) => member.person.name).filter(Boolean),
        studios: movie.studios.map((member) => member.studio.name).filter(Boolean),
      };

      return {
        id: movie.id,
        imdbId: movie.imdbId,
        title: movie.title,
        year: movie.year,
        posterUrl: movie.posterUrl,
        overview: movie.overview,
        era: movie.era,
        source: sourceInfo.source,
        actors: mergeUnique(relationMetadata.actors, omdbMetadata.actors, 3),
        directors: mergeUnique(relationMetadata.directors, omdbMetadata.directors, 2),
        studios: mergeUnique(relationMetadata.studios, omdbMetadata.studios, 2),
        score,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((movie) => ({
      id: movie.id,
      imdbId: movie.imdbId,
      title: movie.title,
      year: movie.year,
      posterUrl: movie.posterUrl,
      overview: movie.overview,
      era: movie.era,
      source: movie.source,
      actors: movie.actors,
      directors: movie.directors,
      studios: movie.studios,
    }));

  return NextResponse.json(scored);
}

function getEra(year: number | null): string | null {
  if (!year) return null;
  const currentYear = new Date().getFullYear();
  if (year >= currentYear - 1) return "new_release";
  if (year >= 2000) return "modern_classic";
  return "classic";
}
