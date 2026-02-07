import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getModelMetadata } from "@/lib/matrix-factorization";

interface AffinityItem {
  id: string;
  name: string;
  affinity: number; // -1 to 1 scale
  ratingCount: number;
}

interface ProfileStats {
  user: {
    name: string;
    explorationFactor: number;
    discoverySourcePref: string;
  };
  counts: {
    moviesRated: number;
    moviesSeen: number;
    actorsRated: number;
    directorsRated: number;
    studiosRated: number;
    genresRanked: number;
  };
  topGenres: AffinityItem[];
  bottomGenres: AffinityItem[];
  topActors: AffinityItem[];
  bottomActors: AffinityItem[];
  topDirectors: AffinityItem[];
  bottomDirectors: AffinityItem[];
  topStudios: AffinityItem[];
  bottomStudios: AffinityItem[];
  recentHighRatedMovies: {
    id: string;
    title: string;
    year: number | null;
    posterUrl: string | null;
    rating: number;
  }[];
  ratingDistribution: {
    rating: number;
    count: number;
  }[];
  mlModel: {
    confidence: number;
    trainedEpochs: number;
    totalRatings: number;
    rmse: number | null;
    validationRmse: number | null;
    featuresLearned: number;
    lastTrainedAt: string | null;
    isTraining: boolean;
  } | null;
}

function normalizeRating(rating: number): number {
  return (rating - 3) / 2; // Convert 1-5 to -1 to 1
}

// Weight for direct ratings vs inferred from movies
const DIRECT_RATING_WEIGHT = 1.0;
const INFERRED_RATING_WEIGHT = 0.3; // Weak influence from movie ratings

interface AffinityAccumulator {
  name: string;
  weightedSum: number;
  totalWeight: number;
}

function mergeAffinities(accumulators: Map<string, AffinityAccumulator>): AffinityItem[] {
  const result: AffinityItem[] = [];
  for (const [id, acc] of accumulators) {
    if (acc.totalWeight > 0) {
      result.push({
        id,
        name: acc.name,
        affinity: acc.weightedSum / acc.totalWeight,
        ratingCount: Math.round(acc.totalWeight),
      });
    }
  }
  return result;
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  // Fetch all user data in parallel
  const [
    user,
    settings,
    genreRankings,
    movieRatings,
    actorRatings,
    directorRatings,
    studioRatings,
  ] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    }),
    prisma.userSettings.findUnique({
      where: { userId },
      select: { explorationFactor: true, discoverySourcePref: true },
    }),
    prisma.genreRanking.findMany({
      where: { userId },
      include: { genre: { select: { id: true, name: true } } },
      orderBy: { rank: "asc" },
    }),
    prisma.movieRating.findMany({
      where: { userId, rating: { not: null } },
      include: {
        movie: {
          select: {
            id: true,
            title: true,
            year: true,
            posterUrl: true,
            cast: {
              select: { person: { select: { id: true, name: true } } },
              take: 5, // Top 5 cast members
              orderBy: { castOrder: "asc" },
            },
            crew: {
              where: { job: "Director" },
              select: { person: { select: { id: true, name: true } } },
            },
            studios: {
              select: { studio: { select: { id: true, name: true } } },
            },
          },
        },
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.actorRating.findMany({
      where: { userId, notHeardOf: false, rating: { not: null } },
      include: { person: { select: { id: true, name: true } } },
    }),
    prisma.directorRating.findMany({
      where: { userId, notHeardOf: false, rating: { not: null } },
      include: { person: { select: { id: true, name: true } } },
    }),
    prisma.studioRating.findMany({
      where: { userId, notHeardOf: false, rating: { not: null } },
      include: { studio: { select: { id: true, name: true } } },
    }),
  ]);

  // Calculate genre affinities from rankings
  const maxRank = genreRankings.length;
  const genreAffinities: AffinityItem[] = genreRankings.map((gr) => ({
    id: gr.genre.id,
    name: gr.genre.name,
    affinity: maxRank <= 1 ? 0 : ((maxRank - gr.rank) / (maxRank - 1)) * 2 - 1,
    ratingCount: 1,
  }));

  // Build actor affinities: direct ratings (strong) + inferred from movies (weak)
  const actorAccumulators = new Map<string, AffinityAccumulator>();

  // Add direct actor ratings with strong weight
  for (const ar of actorRatings) {
    if (ar.rating !== null) {
      actorAccumulators.set(ar.person.id, {
        name: ar.person.name,
        weightedSum: normalizeRating(ar.rating) * DIRECT_RATING_WEIGHT,
        totalWeight: DIRECT_RATING_WEIGHT,
      });
    }
  }

  // Add inferred affinities from movie ratings with weak weight
  for (const mr of movieRatings) {
    if (mr.rating === null) continue;
    const movieAffinity = normalizeRating(mr.rating);

    for (const castMember of mr.movie.cast) {
      const personId = castMember.person.id;
      const existing = actorAccumulators.get(personId);
      if (existing) {
        existing.weightedSum += movieAffinity * INFERRED_RATING_WEIGHT;
        existing.totalWeight += INFERRED_RATING_WEIGHT;
      } else {
        actorAccumulators.set(personId, {
          name: castMember.person.name,
          weightedSum: movieAffinity * INFERRED_RATING_WEIGHT,
          totalWeight: INFERRED_RATING_WEIGHT,
        });
      }
    }
  }

  const actorAffinities = mergeAffinities(actorAccumulators);

  // Build director affinities: direct ratings (strong) + inferred from movies (weak)
  const directorAccumulators = new Map<string, AffinityAccumulator>();

  // Add direct director ratings with strong weight
  for (const dr of directorRatings) {
    if (dr.rating !== null) {
      directorAccumulators.set(dr.person.id, {
        name: dr.person.name,
        weightedSum: normalizeRating(dr.rating) * DIRECT_RATING_WEIGHT,
        totalWeight: DIRECT_RATING_WEIGHT,
      });
    }
  }

  // Add inferred affinities from movie ratings with weak weight
  for (const mr of movieRatings) {
    if (mr.rating === null) continue;
    const movieAffinity = normalizeRating(mr.rating);

    for (const crewMember of mr.movie.crew) {
      const personId = crewMember.person.id;
      const existing = directorAccumulators.get(personId);
      if (existing) {
        existing.weightedSum += movieAffinity * INFERRED_RATING_WEIGHT;
        existing.totalWeight += INFERRED_RATING_WEIGHT;
      } else {
        directorAccumulators.set(personId, {
          name: crewMember.person.name,
          weightedSum: movieAffinity * INFERRED_RATING_WEIGHT,
          totalWeight: INFERRED_RATING_WEIGHT,
        });
      }
    }
  }

  const directorAffinities = mergeAffinities(directorAccumulators);

  // Build studio affinities: direct ratings (strong) + inferred from movies (weak)
  const studioAccumulators = new Map<string, AffinityAccumulator>();

  // Add direct studio ratings with strong weight
  for (const sr of studioRatings) {
    if (sr.rating !== null) {
      studioAccumulators.set(sr.studio.id, {
        name: sr.studio.name,
        weightedSum: normalizeRating(sr.rating) * DIRECT_RATING_WEIGHT,
        totalWeight: DIRECT_RATING_WEIGHT,
      });
    }
  }

  // Add inferred affinities from movie ratings with weak weight
  for (const mr of movieRatings) {
    if (mr.rating === null) continue;
    const movieAffinity = normalizeRating(mr.rating);

    for (const movieStudio of mr.movie.studios) {
      const studioId = movieStudio.studio.id;
      const existing = studioAccumulators.get(studioId);
      if (existing) {
        existing.weightedSum += movieAffinity * INFERRED_RATING_WEIGHT;
        existing.totalWeight += INFERRED_RATING_WEIGHT;
      } else {
        studioAccumulators.set(studioId, {
          name: movieStudio.studio.name,
          weightedSum: movieAffinity * INFERRED_RATING_WEIGHT,
          totalWeight: INFERRED_RATING_WEIGHT,
        });
      }
    }
  }

  const studioAffinities = mergeAffinities(studioAccumulators);

  // Sort and get top/bottom
  const sortByAffinity = (a: AffinityItem, b: AffinityItem) => b.affinity - a.affinity;

  const topGenres = [...genreAffinities].sort(sortByAffinity).slice(0, 5);
  const bottomGenres = [...genreAffinities].sort(sortByAffinity).slice(-5).reverse();

  const topActors = [...actorAffinities].sort(sortByAffinity).slice(0, 5);
  const bottomActors = [...actorAffinities].sort(sortByAffinity).slice(-5).reverse();

  const topDirectors = [...directorAffinities].sort(sortByAffinity).slice(0, 5);
  const bottomDirectors = [...directorAffinities].sort(sortByAffinity).slice(-5).reverse();

  const topStudios = [...studioAffinities].sort(sortByAffinity).slice(0, 5);
  const bottomStudios = [...studioAffinities].sort(sortByAffinity).slice(-5).reverse();

  // Get recent high-rated movies
  const recentHighRatedMovies = movieRatings
    .filter((mr) => mr.rating !== null && mr.rating >= 4)
    .slice(0, 10)
    .map((mr) => ({
      id: mr.movie.id,
      title: mr.movie.title,
      year: mr.movie.year,
      posterUrl: mr.movie.posterUrl,
      rating: mr.rating!,
    }));

  // Calculate rating distribution
  const ratingCounts = new Map<number, number>();
  for (const mr of movieRatings) {
    if (mr.rating !== null) {
      const rounded = Math.round(mr.rating);
      ratingCounts.set(rounded, (ratingCounts.get(rounded) || 0) + 1);
    }
  }
  const ratingDistribution = [1, 2, 3, 4, 5].map((rating) => ({
    rating,
    count: ratingCounts.get(rating) || 0,
  }));

  // Calculate counts
  const moviesRated = movieRatings.filter((mr) => mr.rating !== null).length;
  const moviesSeen = movieRatings.filter((mr) => mr.hasSeen).length;

  // Get ML model metadata
  const modelMetadata = await getModelMetadata();

  const stats: ProfileStats = {
    user: {
      name: user?.name || "Unknown",
      explorationFactor: settings?.explorationFactor ?? 0.5,
      discoverySourcePref: settings?.discoverySourcePref ?? "balanced",
    },
    counts: {
      moviesRated,
      moviesSeen,
      actorsRated: actorRatings.length,
      directorsRated: directorRatings.length,
      studiosRated: studioRatings.length,
      genresRanked: genreRankings.length,
    },
    topGenres,
    bottomGenres,
    topActors,
    bottomActors,
    topDirectors,
    bottomDirectors,
    topStudios,
    bottomStudios,
    recentHighRatedMovies,
    ratingDistribution,
    mlModel: modelMetadata
      ? {
          confidence: modelMetadata.confidence,
          trainedEpochs: modelMetadata.trainedEpochs,
          totalRatings: modelMetadata.totalRatings,
          rmse: modelMetadata.rmse,
          validationRmse: modelMetadata.validationRmse,
          featuresLearned: modelMetadata.featuresLearned,
          lastTrainedAt: modelMetadata.lastTrainedAt?.toISOString() ?? null,
          isTraining: modelMetadata.isTraining,
        }
      : null,
  };

  return NextResponse.json(stats);
}
