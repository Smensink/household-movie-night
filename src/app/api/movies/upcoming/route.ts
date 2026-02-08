import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { syncMoviesToRadarr } from "@/lib/api/radarr";
import { getAnticipatedMovies } from "@/lib/api/trakt";
import { isUserHouseholdAdmin } from "@/lib/household-admin";
import { expandMoviePool, maybeExpandPoolForUser } from "@/lib/movie-pool-expansion";
import {
  averageAffinityForIds,
  buildDiscoveryPreferenceProfile,
} from "@/lib/preference-profile";
import { getAlgorithmSettings } from "@/lib/algorithm-settings";
import {
  getModelMetadata,
  getPredictedRatingsForUser,
} from "@/lib/matrix-factorization";

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 30;
const COLD_START_THRESHOLD = 10;
const MIN_ANTICIPATED_LISTS = 250;
const ANTICIPATED_FETCH_LIMIT = 300;

interface UpcomingMovieResponse {
  id: string;
  imdbId: string | null;
  tmdbId: string | null;
  title: string;
  year: number | null;
  posterUrl: string | null;
  overview: string | null;
  tmdbRating: number | null;
  imdbRating: number | null;
  rottenTomatoesAudience: number | null;
  releaseDate: string | null;
  listCount: number;
  genres: string[];
  actors: string[];
  directors: string[];
  studios: string[];
  consensus: {
    ratingCount: number;
    averageRating: number | null;
    userRating: number | null;
  };
  radarrStatus: {
    inRadarr: boolean;
    available: boolean;
    monitored: boolean;
  } | null;
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

function isColdStartUser(ratedMovieCount: number, ratedGenreCount: number): boolean {
  return ratedMovieCount < COLD_START_THRESHOLD && ratedGenreCount < 5;
}

function mergeUnique(values: string[], extras: string[], limit: number): string[] {
  return Array.from(new Set([...values, ...extras])).slice(0, limit);
}

function getAnticipatedListCount(
  movie: { imdbId: string | null; tmdbId: string | null; traktSlug: string | null },
  maps: {
    imdb: Map<string, number>;
    tmdb: Map<string, number>;
    slug: Map<string, number>;
  }
): number {
  if (movie.imdbId && maps.imdb.has(movie.imdbId)) {
    return maps.imdb.get(movie.imdbId) ?? 0;
  }
  if (movie.tmdbId && maps.tmdb.has(movie.tmdbId)) {
    return maps.tmdb.get(movie.tmdbId) ?? 0;
  }
  if (movie.traktSlug && maps.slug.has(movie.traktSlug)) {
    return maps.slug.get(movie.traktSlug) ?? 0;
  }
  return 0;
}
function computeSourceSignal(
  sourcePref: string,
  metrics: {
    mainstream: number;
    recentness: number;
    ratingQuality: number;
    voteConfidence: number;
  }
): number {
  const { mainstream, recentness, ratingQuality, voteConfidence } = metrics;
  let score01 = 0.5;

  switch (sourcePref) {
    case "trending":
      score01 = mainstream * 0.55 + recentness * 0.3 + ratingQuality * 0.15;
      break;
    case "popular":
      score01 = mainstream * 0.7 + voteConfidence * 0.2 + ratingQuality * 0.1;
      break;
    case "top_rated":
      score01 = ratingQuality * 0.7 + voteConfidence * 0.3;
      break;
    case "new_releases":
      score01 = recentness * 0.75 + mainstream * 0.15 + ratingQuality * 0.1;
      break;
    case "indie_darlings":
      score01 =
        ratingQuality * 0.5 +
        (1 - mainstream) * 0.4 +
        voteConfidence * 0.1;
      break;
    case "balanced":
    default:
      score01 = 0.5;
      break;
  }

  return score01 * 2 - 1;
}

// GET /api/movies/upcoming - Local upcoming feed with discover-style ranking
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;
  const limit = parseLimit(req.nextUrl.searchParams.get("limit"));
  const excludeRadarr = req.nextUrl.searchParams.get("excludeRadarr") === "true";
  const excludeRated = req.nextUrl.searchParams.get("excludeRated") === "true";

  const excludedMovieIds = parseExcludedMovieIds(
    req.nextUrl.searchParams.getAll("excludeMovieIds")
  );

  try {
    const [profile, algorithmSettings, mfMetadata, userSettings] = await Promise.all([
      buildDiscoveryPreferenceProfile(userId),
      getAlgorithmSettings(),
      getModelMetadata(),
      prisma.userSettings.findUnique({
        where: { userId },
        select: { minUpcomingListCount: true },
      }),
    ]);

    const tuning = algorithmSettings.movieDiscovery;
    const mfConfidence = mfMetadata?.confidence ?? 0;
    const minUpcomingListCount = userSettings?.minUpcomingListCount ?? MIN_ANTICIPATED_LISTS;
    const coldStartUser = isColdStartUser(
      profile.userRatedMovieIds.size,
      profile.genreAffinity.size
    );

    const now = new Date();
    const currentYear = now.getFullYear();

    const anticipated = await getAnticipatedMovies(ANTICIPATED_FETCH_LIMIT);
    const anticipatedMaps = {
      imdb: new Map<string, number>(),
      tmdb: new Map<string, number>(),
      slug: new Map<string, number>(),
    };

    for (const item of anticipated) {
      const listCount = item?.list_count ?? 0;
      const ids = item?.movie?.ids;

      if (typeof ids?.imdb === "string" && ids.imdb) {
        anticipatedMaps.imdb.set(ids.imdb, listCount);
      }
      if (typeof ids?.tmdb === "number") {
        anticipatedMaps.tmdb.set(String(ids.tmdb), listCount);
      }
      if (typeof ids?.slug === "string" && ids.slug) {
        anticipatedMaps.slug.set(ids.slug, listCount);
      }
    }

    const fetchCandidateMovies = () =>
      prisma.movie.findMany({
        where: {
          id: { notIn: Array.from(excludedMovieIds) },
          posterUrl: { not: null },
          OR: [
            { releaseDate: { gt: now } },
            { releaseDate: null, year: { gte: currentYear } },
          ],
          ...(excludeRadarr ? { radarrSync: { is: null } } : {}),
        },
        include: {
          genres: {
            select: {
              genreId: true,
              genre: { select: { name: true } },
            },
          },
          cast: {
            include: { person: { select: { name: true } } },
            orderBy: { castOrder: "asc" },
            take: 3,
          },
          crew: {
            where: { job: "Director" },
            include: { person: { select: { name: true } } },
            take: 2,
          },
          studios: {
            include: { studio: { select: { name: true } } },
            take: 2,
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
          radarrSync: true,
          plexAvailability: true,
        },
        orderBy: [
          { releaseDate: "asc" },
          { year: "asc" },
          { popularity: "desc" },
          { updatedAt: "desc" },
        ],
        take: Math.max(limit * 6, 80),
      });

    let candidateMovies = await fetchCandidateMovies();

    // If the local upcoming pool is sparse, synchronously expand once so this request can recover.
    if (candidateMovies.length < Math.min(limit, 5)) {
      try {
        await expandMoviePool();
      } catch (error) {
        console.error("[Upcoming] Synchronous pool expansion failed:", error);
      }
      candidateMovies = await fetchCandidateMovies();
    }

    const candidateMovieIds = candidateMovies.map((movie) => movie.id);
    const mfPredictions =
      mfConfidence > 0
        ? await getPredictedRatingsForUser(userId, candidateMovieIds)
        : new Map<string, number>();

    const scoredMovies = candidateMovies
      .map((movie) => {
        const validRatings = movie.ratings.filter(
          (r) => !r.notHeardOf && r.rating !== null
        );
        const userRating = movie.ratings.find((r) => r.userId === userId);

        if (
          excludeRated &&
          userRating &&
          (userRating.rating !== null || userRating.notHeardOf)
        ) {
          return null;
        }

        const anticipatedListCount = getAnticipatedListCount(movie, anticipatedMaps);

        if (anticipatedListCount <= minUpcomingListCount) {
          return null;
        }

        const averageRating =
          validRatings.length > 0
            ? validRatings.reduce((sum, r) => sum + (r.rating || 0), 0) /
              validRatings.length
            : null;

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

        const explicitRatings = validRatings.map((rating) =>
          normalizeRating(rating.rating as number)
        );
        const householdRatingSignal =
          explicitRatings.length > 0
            ? explicitRatings.reduce((sum, value) => sum + value, 0) /
              explicitRatings.length
            : 0;

        const preferenceSignal = coldStartUser
          ? genreSignal * 0.5 + householdRatingSignal * 0.5
          : genreSignal * 0.3 +
            actorSignal * 0.2 +
            directorSignal * 0.15 +
            studioSignal * 0.15 +
            movieSignal * 0.15 +
            householdRatingSignal * 0.05;

        const actorFamiliarity =
          movie.cast.length === 0
            ? 0
            : movie.cast.filter((castMember) =>
                profile.userRatedActorIds.has(castMember.personId)
              ).length / movie.cast.length;
        const directorFamiliarity =
          movie.crew.length === 0
            ? 0
            : movie.crew.filter((crewMember) =>
                profile.userRatedDirectorIds.has(crewMember.personId)
              ).length / movie.crew.length;
        const studioFamiliarity =
          movie.studios.length === 0
            ? 0
            : movie.studios.filter((studio) =>
                profile.userRatedStudioIds.has(studio.studioId)
              ).length / movie.studios.length;

        const noveltySignal =
          1 -
          (actorFamiliarity * 0.5 +
            directorFamiliarity * 0.2 +
            studioFamiliarity * 0.3);

        const qualityWeight = coldStartUser ? 0.85 : 0.6;
        const popularityWeight = coldStartUser ? 0.15 : 0.4;
        const qualitySignal =
          clamp((movie.voteAverage ?? 0) / 10, 0, 1) * qualityWeight +
          clamp((movie.popularity ?? 0) / 100, 0, 1) * popularityWeight;

        const releaseDate = movie.releaseDate;
        const daysUntilRelease = releaseDate
          ? Math.max(0, (releaseDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
          : 365;
        const recencySoon = clamp(1 - daysUntilRelease / 365, 0, 1);

        const imdbRating = movie.imdbRating ?? 0;
        const tmdbRating = movie.voteAverage ?? 0;
        const bestRating = Math.max(imdbRating, tmdbRating);
        const voteCount = movie.voteCount ?? 0;
        const mainstream = clamp((movie.popularity ?? 0) / 120, 0, 1);
        const ratingQuality = clamp(bestRating / 10, 0, 1);
        const voteConfidence = clamp(Math.log10(voteCount + 1) / 5, 0, 1);
        const sourceSignal = computeSourceSignal(profile.discoverySourcePref, {
          mainstream,
          recentness: recencySoon,
          ratingQuality,
          voteConfidence,
        });

        const adjustedNoveltyInfluence = tuning.noveltyInfluence * 0.4;
        const adjustedQualityInfluence = tuning.qualityInfluence * 1.3;
        const discoveryWeightsTotal =
          adjustedNoveltyInfluence + adjustedQualityInfluence + tuning.sourceInfluence;
        const discoveryBase =
          discoveryWeightsTotal > 0
            ? (noveltySignal * adjustedNoveltyInfluence +
                qualitySignal * adjustedQualityInfluence +
                sourceSignal * tuning.sourceInfluence) /
              discoveryWeightsTotal
            : noveltySignal * 0.3 + qualitySignal * 0.7;
        const discoverySignal = discoveryBase * 2 - 1;

        const effectiveExplorationFactor = coldStartUser
          ? Math.max(0.7, profile.explorationFactor)
          : Math.pow(profile.explorationFactor, 1.5);

        const strongDislikes = movie.ratings.filter(
          (rating) => !rating.notHeardOf && rating.rating !== null && rating.rating <= 2
        ).length;
        const dislikePenalty =
          strongDislikes > 0 ? strongDislikes * tuning.dislikePenalty : 0;

        const availabilitySignal =
          movie.radarrSync?.available || movie.plexAvailability?.available ? 1 : 0;

        const releaseSoonBoost = recencySoon * 0.35;
        const yearConfidenceBoost = (movie.year ?? currentYear + 1) >= currentYear ? 0.08 : 0;

        const mfPredictedRating = mfPredictions.get(movie.id);
        const mfSignal =
          mfPredictedRating !== undefined
            ? clamp((mfPredictedRating - 3) / 2, -1, 1)
            : 0;

        const mfWeight = mfConfidence * 0.4;
        const heuristicWeight = 1 - mfWeight;
        const confidenceWeight = coldStartUser ? 0.5 : 1.0;

        const heuristicScore =
          preferenceSignal *
            tuning.preferenceWeight *
            (1 - effectiveExplorationFactor) +
          discoverySignal *
            tuning.discoveryWeight *
            effectiveExplorationFactor +
          releaseSoonBoost +
          yearConfidenceBoost +
          availabilitySignal * tuning.availabilityBonus +
          dislikePenalty +
          Math.random() * tuning.randomJitter;

        const score =
          (heuristicScore * heuristicWeight + mfSignal * mfWeight) * confidenceWeight;

        return {
          id: movie.id,
          imdbId: movie.imdbId,
          tmdbId: movie.tmdbId,
          title: movie.title,
          year: movie.year,
          posterUrl: movie.posterUrl,
          overview: movie.overview,
          tmdbRating: movie.voteAverage,
          imdbRating: movie.imdbRating,
          rottenTomatoesAudience: movie.rottenTomatoesAudience,
          releaseDate: movie.releaseDate?.toISOString() || null,
          listCount: anticipatedListCount,
          genres: movie.genres.map((g) => g.genre.name).filter(Boolean).slice(0, 3),
          actors: mergeUnique(movie.cast.map((c) => c.person.name).filter(Boolean), [], 3),
          directors: mergeUnique(movie.crew.map((c) => c.person.name).filter(Boolean), [], 2),
          studios: mergeUnique(movie.studios.map((s) => s.studio.name).filter(Boolean), [], 2),
          consensus: {
            ratingCount: validRatings.length,
            averageRating,
            userRating: userRating?.rating || null,
          },
          radarrStatus: movie.radarrSync
            ? {
                inRadarr: true,
                available: movie.radarrSync.available,
                monitored: movie.radarrSync.monitored,
              }
            : null,
          score,
        };
      })
      .filter((movie): movie is NonNullable<typeof movie> => movie !== null)
      .sort((a, b) => b.score - a.score);

    const finalResults: UpcomingMovieResponse[] = scoredMovies.slice(0, limit).map((movie) => ({
      id: movie.id,
      imdbId: movie.imdbId,
      tmdbId: movie.tmdbId,
      title: movie.title,
      year: movie.year,
      posterUrl: movie.posterUrl,
      overview: movie.overview,
      tmdbRating: movie.tmdbRating,
      imdbRating: movie.imdbRating,
      rottenTomatoesAudience: movie.rottenTomatoesAudience,
      releaseDate: movie.releaseDate,
      listCount: movie.listCount,
      genres: movie.genres,
      actors: movie.actors,
      directors: movie.directors,
      studios: movie.studios,
      consensus: movie.consensus,
      radarrStatus: movie.radarrStatus,
    }));

    maybeExpandPoolForUser(userId);
    if (finalResults.length < limit) {
      expandMoviePool().catch((error) => {
        console.error("[Upcoming] Background pool expansion failed:", error);
      });
    }

    return NextResponse.json(finalResults);
  } catch (error) {
    console.error("Error fetching upcoming movies:", error);
    return NextResponse.json(
      { error: "Failed to fetch upcoming movies" },
      { status: 500 }
    );
  }
}

// POST /api/movies/upcoming - Sync selected movies to Radarr
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isAdmin = await isUserHouseholdAdmin(session.user.id);
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { movieIds } = await req.json();

    if (!Array.isArray(movieIds) || movieIds.length === 0) {
      return NextResponse.json(
        { error: "Movie IDs required" },
        { status: 400 }
      );
    }

    const results = await syncMoviesToRadarr(movieIds);

    return NextResponse.json({ results });
  } catch (error) {
    console.error("Error syncing to Radarr:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to sync to Radarr",
      },
      { status: 500 }
    );
  }
}












