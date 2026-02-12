import { prisma } from "./prisma";

interface GenreRankingRow {
  userId: string;
  genreId: string;
  rank: number;
}

interface RatingRow {
  userId: string;
  rating: number | null;
  notHeardOf: boolean;
}

interface MovieRatingRow extends RatingRow {
  movieId: string;
  hasSeen: boolean;
}

interface PersonRatingRow extends RatingRow {
  personId: string;
}

interface StudioRatingRow extends RatingRow {
  studioId: string;
}

interface LoadedPreferenceRows {
  settings: Array<{
    userId: string;
    explorationFactor: number;
    discoverySourcePref: string;
  }>;
  totalGenres: number;
  genreRankings: GenreRankingRow[];
  movieRatings: MovieRatingRow[];
  actorRatings: PersonRatingRow[];
  directorRatings: PersonRatingRow[];
  studioRatings: StudioRatingRow[];
}

export interface AffinityProfile {
  genreAffinity: Map<string, number>;
  movieAffinity: Map<string, number>;
  actorAffinity: Map<string, number>;
  directorAffinity: Map<string, number>;
  studioAffinity: Map<string, number>;
}

export interface DiscoveryPreferenceProfile extends AffinityProfile {
  userId: string;
  householdUserIds: string[];
  explorationFactor: number;
  discoverySourcePref: string;
  userRatedMovieIds: Set<string>;
  userRatedActorIds: Set<string>;
  userRatedDirectorIds: Set<string>;
  userRatedStudioIds: Set<string>;
}

export interface GroupPreferenceProfile extends AffinityProfile {
  userIds: string[];
  avgExplorationFactor: number;
}

function normalizeFiveStarRating(rating: number): number {
  return (rating - 3) / 2;
}

function average(numbers: number[]): number {
  if (numbers.length === 0) return 0;
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function finalizeWeightedMap(
  map: Map<string, { weightedSum: number; totalWeight: number }>
): Map<string, number> {
  const result = new Map<string, number>();
  for (const [key, value] of map) {
    if (value.totalWeight <= 0) continue;
    result.set(key, value.weightedSum / value.totalWeight);
  }
  return result;
}

function addWeighted(
  map: Map<string, { weightedSum: number; totalWeight: number }>,
  key: string,
  score: number,
  weight: number
) {
  if (!key || weight <= 0) return;
  const current = map.get(key) ?? { weightedSum: 0, totalWeight: 0 };
  current.weightedSum += score * weight;
  current.totalWeight += weight;
  map.set(key, current);
}

function buildGenreAffinity(
  genreRankings: GenreRankingRow[],
  userWeights: Map<string, number>,
  totalGenreCount: number
): Map<string, number> {
  const safeTotalGenres = Math.max(totalGenreCount, 1);
  const aggregated = new Map<string, { weightedSum: number; totalWeight: number }>();

  for (const ranking of genreRankings) {
    const userWeight = userWeights.get(ranking.userId) ?? 0;
    if (userWeight <= 0) continue;

    const boundedRank = Math.min(Math.max(ranking.rank, 1), safeTotalGenres);
    const normalizedRank =
      safeTotalGenres <= 1
        ? 1
        : (safeTotalGenres - boundedRank) / (safeTotalGenres - 1);
    const score = normalizedRank * 2 - 1;
    addWeighted(aggregated, ranking.genreId, score, userWeight * DIRECT_RATING_WEIGHT);
  }

  return finalizeWeightedMap(aggregated);
}

function buildRatingAffinity<T extends RatingRow>(
  rows: T[],
  getKey: (row: T) => string,
  userWeights: Map<string, number>
): Map<string, number> {
  const aggregated = new Map<string, { weightedSum: number; totalWeight: number }>();
  for (const row of rows) {
    const userWeight = userWeights.get(row.userId) ?? 0;
    if (userWeight <= 0 || row.notHeardOf || row.rating === null) continue;
    const score = normalizeFiveStarRating(row.rating);
    addWeighted(aggregated, getKey(row), score, userWeight);
  }

  return finalizeWeightedMap(aggregated);
}

async function getHouseholdUserIdsForUser(userId: string): Promise<string[]> {
  const memberships = await prisma.householdMember.findMany({
    where: { userId },
    select: { householdId: true },
  });

  if (memberships.length === 0) {
    return [userId];
  }

  const householdIds = memberships.map((membership) => membership.householdId);
  const householdMembers = await prisma.householdMember.findMany({
    where: { householdId: { in: householdIds } },
    select: { userId: true },
  });

  const uniqueUserIds = new Set<string>([userId]);
  for (const member of householdMembers) {
    uniqueUserIds.add(member.userId);
  }

  return Array.from(uniqueUserIds);
}

interface MovieMetadata {
  movieId: string;
  genreIds: string[];
  actorIds: string[];
  directorIds: string[];
  studioIds: string[];
}

async function loadPreferenceRows(userIds: string[]): Promise<LoadedPreferenceRows> {
  const [settings, totalGenres, genreRankings, movieRatings, actorRatings, directorRatings, studioRatings] =
    await Promise.all([
      prisma.userSettings.findMany({
        where: { userId: { in: userIds } },
        select: {
          userId: true,
          explorationFactor: true,
          discoverySourcePref: true,
        },
      }),
      prisma.genre.count(),
      prisma.genreRanking.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, genreId: true, rank: true },
      }),
      prisma.movieRating.findMany({
        where: { userId: { in: userIds } },
        select: {
          userId: true,
          movieId: true,
          rating: true,
          notHeardOf: true,
          hasSeen: true,
        },
      }),
      prisma.actorRating.findMany({
        where: { userId: { in: userIds } },
        select: {
          userId: true,
          personId: true,
          rating: true,
          notHeardOf: true,
        },
      }),
      prisma.directorRating.findMany({
        where: { userId: { in: userIds } },
        select: {
          userId: true,
          personId: true,
          rating: true,
          notHeardOf: true,
        },
      }),
      prisma.studioRating.findMany({
        where: { userId: { in: userIds } },
        select: {
          userId: true,
          studioId: true,
          rating: true,
          notHeardOf: true,
        },
      }),
    ]);

  return {
    settings,
    totalGenres,
    genreRankings,
    movieRatings,
    actorRatings,
    directorRatings,
    studioRatings,
  };
}

async function loadMovieMetadata(movieIds: string[]): Promise<Map<string, MovieMetadata>> {
  if (movieIds.length === 0) return new Map();

  const movies = await prisma.movie.findMany({
    where: { id: { in: movieIds } },
    select: {
      id: true,
      genres: {
        select: { genreId: true },
      },
      cast: {
        select: { personId: true },
        take: 5,
        orderBy: { castOrder: "asc" },
      },
      crew: {
        where: { job: "Director" },
        select: { personId: true },
      },
      studios: {
        select: { studioId: true },
      },
    },
  });

  const metadataMap = new Map<string, MovieMetadata>();
  for (const movie of movies) {
    metadataMap.set(movie.id, {
      movieId: movie.id,
      genreIds: movie.genres.map((g) => g.genreId),
      actorIds: movie.cast.map((c) => c.personId),
      directorIds: movie.crew.map((c) => c.personId),
      studioIds: movie.studios.map((s) => s.studioId),
    });
  }
  return metadataMap;
}

// Weight for direct ratings vs inferred from movies
const DIRECT_RATING_WEIGHT = 1.0;
const INFERRED_RATING_WEIGHT = 0.3;

function buildAffinitiesWithInference(
  rows: LoadedPreferenceRows,
  userWeights: Map<string, number>,
  movieMetadata: Map<string, MovieMetadata>
): AffinityProfile {
  const genreAggregated = new Map<string, { weightedSum: number; totalWeight: number }>();
  const movieAffinity = buildRatingAffinity(rows.movieRatings, (row) => row.movieId, userWeights);

  const directGenreAffinity = buildGenreAffinity(rows.genreRankings, userWeights, rows.totalGenres);
  for (const [genreId, score] of directGenreAffinity) {
    addWeighted(genreAggregated, genreId, score, DIRECT_RATING_WEIGHT);
  }

  const actorAggregated = new Map<string, { weightedSum: number; totalWeight: number }>();
  const directorAggregated = new Map<string, { weightedSum: number; totalWeight: number }>();
  const studioAggregated = new Map<string, { weightedSum: number; totalWeight: number }>();

  for (const row of rows.actorRatings) {
    const userWeight = userWeights.get(row.userId) ?? 0;
    if (userWeight <= 0 || row.notHeardOf || row.rating === null) continue;
    const score = normalizeFiveStarRating(row.rating);
    addWeighted(actorAggregated, row.personId, score, userWeight * DIRECT_RATING_WEIGHT);
  }

  for (const row of rows.directorRatings) {
    const userWeight = userWeights.get(row.userId) ?? 0;
    if (userWeight <= 0 || row.notHeardOf || row.rating === null) continue;
    const score = normalizeFiveStarRating(row.rating);
    addWeighted(directorAggregated, row.personId, score, userWeight * DIRECT_RATING_WEIGHT);
  }

  for (const row of rows.studioRatings) {
    const userWeight = userWeights.get(row.userId) ?? 0;
    if (userWeight <= 0 || row.notHeardOf || row.rating === null) continue;
    const score = normalizeFiveStarRating(row.rating);
    addWeighted(studioAggregated, row.studioId, score, userWeight * DIRECT_RATING_WEIGHT);
  }

  for (const row of rows.movieRatings) {
    const userWeight = userWeights.get(row.userId) ?? 0;
    if (userWeight <= 0 || row.notHeardOf || row.rating === null) continue;
    const score = normalizeFiveStarRating(row.rating);
    const metadata = movieMetadata.get(row.movieId);
    if (!metadata) continue;

    for (const genreId of metadata.genreIds) {
      addWeighted(genreAggregated, genreId, score, userWeight * INFERRED_RATING_WEIGHT);
    }
    for (const actorId of metadata.actorIds) {
      addWeighted(actorAggregated, actorId, score, userWeight * INFERRED_RATING_WEIGHT);
    }
    for (const directorId of metadata.directorIds) {
      addWeighted(directorAggregated, directorId, score, userWeight * INFERRED_RATING_WEIGHT);
    }
    for (const studioId of metadata.studioIds) {
      addWeighted(studioAggregated, studioId, score, userWeight * INFERRED_RATING_WEIGHT);
    }
  }

  return {
    genreAffinity: finalizeWeightedMap(genreAggregated),
    movieAffinity,
    actorAffinity: finalizeWeightedMap(actorAggregated),
    directorAffinity: finalizeWeightedMap(directorAggregated),
    studioAffinity: finalizeWeightedMap(studioAggregated),
  };
}

export async function buildDiscoveryPreferenceProfile(
  userId: string
): Promise<DiscoveryPreferenceProfile> {
  const householdUserIds = await getHouseholdUserIdsForUser(userId);
  const rows = await loadPreferenceRows(householdUserIds);

  // Load movie metadata for rated movies to infer actor/director/studio affinities
  const ratedMovieIds = rows.movieRatings
    .filter((r) => r.rating !== null && !r.notHeardOf)
    .map((r) => r.movieId);
  const movieMetadata = await loadMovieMetadata(ratedMovieIds);

  const userWeights = new Map<string, number>();
  for (const relatedUserId of householdUserIds) {
    userWeights.set(relatedUserId, relatedUserId === userId ? 1 : 0.45);
  }

  const affinities = buildAffinitiesWithInference(rows, userWeights, movieMetadata);
  const primarySetting = rows.settings.find((setting) => setting.userId === userId);
  const avgExploration =
    rows.settings.length > 0
      ? average(rows.settings.map((setting) => setting.explorationFactor))
      : 0.5;
  const explorationFactor =
    primarySetting?.explorationFactor ?? (rows.settings.length > 0 ? avgExploration : 0.5);

  const userMovieRatings = rows.movieRatings.filter((rating) => rating.userId === userId);
  const userActorRatings = rows.actorRatings.filter((rating) => rating.userId === userId);
  const userDirectorRatings = rows.directorRatings.filter(
    (rating) => rating.userId === userId
  );
  const userStudioRatings = rows.studioRatings.filter((rating) => rating.userId === userId);

  return {
    userId,
    householdUserIds,
    explorationFactor,
    discoverySourcePref: primarySetting?.discoverySourcePref ?? "balanced",
    userRatedMovieIds: new Set(userMovieRatings.map((rating) => rating.movieId)),
    userRatedActorIds: new Set(userActorRatings.map((rating) => rating.personId)),
    userRatedDirectorIds: new Set(userDirectorRatings.map((rating) => rating.personId)),
    userRatedStudioIds: new Set(userStudioRatings.map((rating) => rating.studioId)),
    ...affinities,
  };
}

export async function buildGroupPreferenceProfile(
  userIds: string[]
): Promise<GroupPreferenceProfile> {
  const dedupedUserIds = Array.from(new Set(userIds));
  const rows = await loadPreferenceRows(dedupedUserIds);

  // Load movie metadata for rated movies to infer actor/director/studio affinities
  const ratedMovieIds = rows.movieRatings
    .filter((r) => r.rating !== null && !r.notHeardOf)
    .map((r) => r.movieId);
  const movieMetadata = await loadMovieMetadata(ratedMovieIds);

  const userWeights = new Map<string, number>(
    dedupedUserIds.map((id) => [id, 1])
  );
  const affinities = buildAffinitiesWithInference(rows, userWeights, movieMetadata);
  const avgExploration =
    rows.settings.length > 0
      ? average(rows.settings.map((setting) => setting.explorationFactor))
      : 0.5;

  return {
    userIds: dedupedUserIds,
    avgExplorationFactor: avgExploration,
    ...affinities,
  };
}

export function averageAffinityForIds(
  ids: string[],
  affinityMap: Map<string, number>
): number {
  if (ids.length === 0) return 0;
  const values = ids
    .map((id) => affinityMap.get(id))
    .filter((value): value is number => value !== undefined);
  return average(values);
}



