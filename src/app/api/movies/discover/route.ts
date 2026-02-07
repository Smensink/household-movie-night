import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getHighResPosterUrl } from "@/lib/api/omdb";
import { prisma } from "@/lib/prisma";
import { extractMovieMetadataFromRelations } from "@/lib/movie-metadata";
import {
  averageAffinityForIds,
  buildDiscoveryPreferenceProfile,
} from "@/lib/preference-profile";
import { getAlgorithmSettings } from "@/lib/algorithm-settings";
import {
  getPredictedRatingsForUser,
  getModelMetadata,
} from "@/lib/matrix-factorization";

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 30;
const COLD_START_THRESHOLD = 10; // Minimum ratings before personalized recommendations
const DIVERSITY_INJECTION_RATE = 0.15; // 15% of recommendations from diverse sources

function parseLimit(value: string | null): number {
  if (!value) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, parsed));
}

function isColdStartUser(ratedMovieCount: number, ratedGenreCount: number): boolean {
  // User is in cold start if they have very few ratings
  return ratedMovieCount < COLD_START_THRESHOLD && ratedGenreCount < 5;
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

  // Detect cold start users for special handling
  const userRatingCount = profile.userRatedMovieIds.size;
  const userGenreRankingCount = profile.genreAffinity.size;
  const coldStartUser = isColdStartUser(userRatingCount, userGenreRankingCount);

  // Get Matrix Factorization model for collaborative filtering
  const mfMetadata = await getModelMetadata();
  const mfConfidence = mfMetadata?.confidence ?? 0;

  // Build exclusion set from query params and user's rated movies
  const excludedMovieIds = parseExcludedMovieIds(
    req.nextUrl.searchParams.getAll("excludeMovieIds")
  );
  for (const ratedMovieId of profile.userRatedMovieIds) {
    excludedMovieIds.add(ratedMovieId);
  }

  // FAST PATH: Query local database directly
  // Get movies the user hasn't rated, with posters, that have been released
  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();

  const candidateMovies = await prisma.movie.findMany({
    where: {
      id: { notIn: Array.from(excludedMovieIds) },
      posterUrl: { not: null },
      // Only show released movies
      OR: [
        { releaseDate: { lte: currentDate } },
        { releaseDate: null, year: { lte: currentYear } },
      ],
    },
    include: {
      genres: {
        select: {
          genreId: true,
          genre: { select: { name: true } },
        },
      },
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
    orderBy: [
      { popularity: "desc" },
      { voteAverage: "desc" },
      { updatedAt: "desc" },
    ],
    take: Math.max(limit * 4, 60), // Get more than needed for scoring
  });

  // Get MF predicted ratings for candidate movies (batch)
  const candidateMovieIds = candidateMovies.map((m) => m.id);
  const mfPredictions =
    mfConfidence > 0
      ? await getPredictedRatingsForUser(userId, candidateMovieIds)
      : new Map<string, number>();

  // Score and rank movies
  // Track genre distribution for diversity injection
  const genreDistribution = new Map<string, number>();

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

      // COLD START: For new users, rely more heavily on global quality signals
      // rather than non-existent preference signals
      const preferenceSignal = coldStartUser
        ? genreSignal * 0.5 + householdRatingSignal * 0.5 // Simplified for cold start
        : genreSignal * 0.3 +
          actorSignal * 0.2 +
          directorSignal * 0.15 +
          studioSignal * 0.15 +
          movieSignal * 0.15 +
          householdRatingSignal * 0.05;

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

      // COLD START: Weight quality higher for new users
      const qualityWeight = coldStartUser ? 0.85 : 0.6;
      const popularityWeight = coldStartUser ? 0.15 : 0.4;
      const qualitySignal =
        clamp((movie.voteAverage ?? 0) / 10, 0, 1) * qualityWeight +
        clamp((movie.popularity ?? 0) / 100, 0, 1) * popularityWeight;

      const userRating = movie.ratings.find((rating) => rating.userId === userId);
      const unseenBonus = userRating?.hasSeen ? -0.35 : 0.15;

      // COLD START: Use higher exploration factor for new users
      const effectiveExplorationFactor = coldStartUser
        ? Math.max(0.7, profile.explorationFactor) // At least 70% exploration for cold start
        : profile.explorationFactor;

      const discoveryWeightsTotal =
        tuning.noveltyInfluence + tuning.qualityInfluence + tuning.sourceInfluence;
      const discoveryBase =
        discoveryWeightsTotal > 0
          ? (noveltySignal * tuning.noveltyInfluence +
              qualitySignal * tuning.qualityInfluence) /
            discoveryWeightsTotal
          : (noveltySignal + qualitySignal) / 2;
      const discoverySignal = discoveryBase * 2 - 1 + unseenBonus;

      const strongDislikes = movie.ratings.filter(
        (rating) => !rating.notHeardOf && rating.rating !== null && rating.rating <= 2
      ).length;
      const dislikePenalty =
        strongDislikes > 0 ? strongDislikes * tuning.dislikePenalty : 0;

      const availabilitySignal =
        movie.radarrSync?.available || movie.plexAvailability?.available ? 1 : 0;

      // ACTIVE LEARNING: Boost movies that would teach us the most
      // Movies with polarizing opinions or from under-explored genres are more informative
      const genreExplorationBonus = movie.genres.some(
        (g) => !profile.genreAffinity.has(g.genreId)
      )
        ? 0.15
        : 0;

      // CONFIDENCE: Weight down movies where we have low confidence
      // (e.g., genres the user hasn't rated much in)
      const confidenceWeight = coldStartUser ? 0.5 : 1.0;

      // MATRIX FACTORIZATION: Collaborative filtering score
      // Predicted rating is 1-5, normalize to -1 to 1 scale
      const mfPredictedRating = mfPredictions.get(movie.id);
      const mfSignal = mfPredictedRating !== undefined
        ? (mfPredictedRating - 3) / 2 // Convert 1-5 to -1 to 1
        : 0;

      // Blend MF with heuristic scoring based on model confidence
      // As confidence increases, MF gets more weight (up to 40% at full confidence)
      const mfWeight = mfConfidence * 0.4; // 0% to 40% based on confidence
      const heuristicWeight = 1 - mfWeight;

      const heuristicScore =
        preferenceSignal *
          tuning.preferenceWeight *
          (1 - effectiveExplorationFactor) +
        discoverySignal *
          tuning.discoveryWeight *
          effectiveExplorationFactor +
        availabilitySignal * tuning.availabilityBonus +
        dislikePenalty +
        genreExplorationBonus +
        Math.random() * tuning.randomJitter;

      const score =
        (heuristicScore * heuristicWeight + mfSignal * mfWeight) * confidenceWeight;

      const relationMetadata = extractMovieMetadataFromRelations(movie);
      const dbMetadata = {
        actors: movie.cast.map((member) => member.person.name).filter(Boolean),
        directors: movie.crew.map((member) => member.person.name).filter(Boolean),
        studios: movie.studios.map((member) => member.studio.name).filter(Boolean),
      };

      const genres = movie.genres
        .map((g) => g.genre.name)
        .filter(Boolean)
        .slice(0, 3);

      return {
        id: movie.id,
        imdbId: movie.imdbId,
        title: movie.title,
        year: movie.year,
        posterUrl: movie.posterUrl,
        overview: movie.overview,
        era: movie.era,
        imdbRating: movie.imdbRating,
        rottenTomatoesAudience: movie.rottenTomatoesAudience,
        genres,
        actors: mergeUnique(relationMetadata.actors, dbMetadata.actors, 3),
        directors: mergeUnique(relationMetadata.directors, dbMetadata.directors, 2),
        studios: mergeUnique(relationMetadata.studios, dbMetadata.studios, 2),
        score,
      };
    })
    .sort((a, b) => b.score - a.score);

  // DIVERSITY INJECTION: Ensure variety in the final results
  // Select top movies but ensure genre diversity
  const diverseResults: typeof scored = [];
  const usedGenres = new Set<string>();
  const diversitySlots = Math.floor(limit * DIVERSITY_INJECTION_RATE);
  const mainSlots = limit - diversitySlots;

  // First pass: fill main slots with top-scored movies
  for (const movie of scored) {
    if (diverseResults.length >= mainSlots) break;
    diverseResults.push(movie);
    for (const genre of movie.genres) {
      usedGenres.add(genre);
    }
  }

  // Second pass: fill diversity slots with movies from underrepresented genres
  for (const movie of scored) {
    if (diverseResults.length >= limit) break;
    if (diverseResults.some((r) => r.id === movie.id)) continue;

    // Prefer movies with genres we haven't seen much
    const hasNewGenre = movie.genres.some((g) => !usedGenres.has(g));
    if (hasNewGenre) {
      diverseResults.push(movie);
      for (const genre of movie.genres) {
        usedGenres.add(genre);
      }
    }
  }

  // Fill remaining slots with next best movies if diversity pass didn't fill
  for (const movie of scored) {
    if (diverseResults.length >= limit) break;
    if (!diverseResults.some((r) => r.id === movie.id)) {
      diverseResults.push(movie);
    }
  }

  const finalResults = diverseResults
    .slice(0, limit)
    .map((movie) => ({
      id: movie.id,
      imdbId: movie.imdbId,
      title: movie.title,
      year: movie.year,
      posterUrl: getHighResPosterUrl(movie.posterUrl) || movie.posterUrl,
      overview: movie.overview,
      era: movie.era,
      imdbRating: movie.imdbRating,
      rottenTomatoesAudience: movie.rottenTomatoesAudience,
      genres: movie.genres,
      actors: movie.actors,
      directors: movie.directors,
      studios: movie.studios,
    }));

  return NextResponse.json(finalResults);
}
