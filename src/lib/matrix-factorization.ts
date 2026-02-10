/**
 * Hybrid Factorization Machine for Collaborative Filtering
 *
 * Implements a Factorization Machine that combines:
 * - User/Movie latent vectors (like Funk SVD)
 * - Side features: genres, era, popularity, runtime, cast, crew, studios
 * - User features: exploration factor, genre preferences, rating patterns
 * - Temporal features: release recency, rating timestamp
 * - Household features: other members' ratings
 *
 * Prediction formula:
 * rating = global_mean + user_bias + movie_bias
 *        + dot(user_vector, movie_vector)
 *        + sum(feature_weights * feature_values)
 *        + sum(dot(feature_i_vector, feature_j_vector) for all feature pairs)
 */

import { prisma } from "./prisma";

// Lazy-loaded TensorFlow.js module (GPU with CPU fallback)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _tf: any = undefined; // undefined = not yet tried, null = unavailable
let _tfBackend: "gpu" | "cpu" | "none" | "pending" = "pending";

async function getTF(): Promise<{ tf: any; backend: "gpu" | "cpu" } | null> {
  if (_tfBackend === "none") return null;
  if (_tf) return { tf: _tf, backend: _tfBackend as "gpu" | "cpu" };

  try {
    _tf = await import("@tensorflow/tfjs-node-gpu");
    _tfBackend = "gpu";
    console.log("[MF] TensorFlow.js GPU backend loaded");
    return { tf: _tf, backend: "gpu" };
  } catch {
    try {
      _tf = await import("@tensorflow/tfjs-node");
      _tfBackend = "cpu";
      console.log("[MF] TensorFlow.js CPU (BLAS) backend loaded");
      return { tf: _tf, backend: "cpu" };
    } catch {
      console.log("[MF] TensorFlow.js not available, using pure JS training");
      _tf = null;
      _tfBackend = "none";
      return null;
    }
  }
}

// Model hyperparameters
const DEFAULT_LATENT_DIMENSIONS = 50;
const DEFAULT_FEATURE_DIMENSIONS = 16;
const DEFAULT_LEARNING_RATE = 0.005;
const DEFAULT_REGULARIZATION = 0.02;
const DEFAULT_EPOCHS = 20;
const MIN_RATINGS_TO_TRAIN = 20;
const VALIDATION_SPLIT = 0.1;
const ML_SAMPLE_USERS = 500000; // Sample up to 500K ML users (effectively all ~200K+)
const ML_RATING_WEIGHT = 0.1; // Relative weight vs household ratings (1.0)
const ML_SAMPLE_PER_EPOCH = Infinity; // Use ALL mapped ML ratings every epoch

// Feature types
type FeatureType =
  | "genre"
  | "era"
  | "studio"
  | "actor"
  | "director"
  | "language"
  | "origin_country"
  | "tag"
  | "popularity_bin"
  | "runtime_bin"
  | "vote_avg_bin"
  | "vote_count_bin"
  | "surprise_factor_bin"
  | "user_exploration"
  | "user_rating_pattern"
  | "household_consensus";

interface Rating {
  userId: string;
  movieId: string;
  rating: number;
  weight: number; // 1.0 for household, ML_RATING_WEIGHT for ML community
  movieFeatures: MovieFeatures;
  userFeatures: UserFeatures;
  householdFeatures: HouseholdFeatures;
}

interface MovieFeatures {
  genreIds: string[];
  era: string | null;
  language: string | null;
  originCountry: string | null;
  tags: { tag: string; relevance: number }[];
  studioIds: string[];
  actorIds: string[];
  directorIds: string[];
  popularityBin: string;
  runtimeBin: string;
  voteAvgBin: string;
  voteCountBin: string;
  surpriseFactorBin: string;
}

interface UserFeatures {
  explorationFactor: number;
  ratingMean: number;
  ratingStdDev: number;
  ratingCount: number;
  topGenreIds: string[];
}

interface HouseholdFeatures {
  otherUserRatings: Map<string, number>; // userId -> rating
  consensusScore: number; // Average of other household members' ratings
}

interface LatentVectors {
  userVectors: Map<string, number[]>;
  movieVectors: Map<string, number[]>;
  userBiases: Map<string, number>;
  movieBiases: Map<string, number>;
  featureEmbeddings: Map<string, { vector: number[]; bias: number }>;
  globalMean: number;
}

/**
 * Initialize random latent vectors for a new entity
 */
function initializeVector(dimensions: number): number[] {
  return Array.from({ length: dimensions }, () => (Math.random() - 0.5) * 0.1);
}

/**
 * Compute dot product of two vectors
 */
function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/**
 * Bin continuous values into categorical features
 */
function binPopularity(popularity: number | null): string {
  if (popularity === null || popularity === 0) return "unknown";
  if (popularity < 10) return "niche";
  if (popularity < 50) return "moderate";
  if (popularity < 100) return "popular";
  return "blockbuster";
}

function binRuntime(runtime: number | null): string {
  if (runtime === null || runtime === 0) return "unknown";
  if (runtime < 90) return "short";
  if (runtime < 120) return "standard";
  if (runtime < 150) return "long";
  return "epic";
}

function binVoteAverage(voteAvg: number | null): string {
  if (voteAvg === null || voteAvg === 0) return "unknown";
  if (voteAvg < 5) return "poor";
  if (voteAvg < 6.5) return "mixed";
  if (voteAvg < 7.5) return "good";
  return "excellent";
}

function binVoteCount(voteCount: number | null): string {
  if (voteCount === null || voteCount === 0) return "unknown";
  if (voteCount < 100) return "obscure";       // Very few have seen it
  if (voteCount < 1000) return "niche";        // Cult following or indie
  if (voteCount < 5000) return "known";        // Reasonably well-known
  if (voteCount < 20000) return "popular";     // Mainstream
  return "blockbuster";                         // Everyone knows it
}

function binExploration(factor: number): string {
  if (factor < 0.3) return "conservative";
  if (factor < 0.7) return "moderate";
  return "adventurous";
}

function binSurpriseFactor(surpriseFactor: number | null): string {
  if (surpriseFactor === null) return "unknown";
  if (surpriseFactor > 0.5) return "exceeds_expectations";
  if (surpriseFactor < -0.5) return "disappointing";
  return "meets_expectations";
}

function classifyRatingDisposition(mean: number, stdDev: number, count: number): string {
  if (count < 5) return "insufficient";
  const leniency = mean - 3.0;
  const isDiscriminating = stdDev > 0.8;
  if (Math.abs(leniency) < 0.3) return isDiscriminating ? "balanced_wide" : "balanced_narrow";
  if (leniency >= 0.3) return isDiscriminating ? "lenient_wide" : "lenient_narrow";
  return isDiscriminating ? "harsh_wide" : "harsh_narrow";
}

function normalizeRating(rating: number, userMean: number, userStdDev: number): number {
  if (userStdDev < 0.1) return rating;
  return Math.max(1, Math.min(5, 3 + (rating - userMean) / userStdDev));
}

/**
 * Get feature key for embedding lookup
 */
function getFeatureKey(type: FeatureType, id: string): string {
  return `${type}:${id}`;
}

/**
 * Compute feature contribution to prediction (everything except core MF dot product and biases).
 * Used by GPU batch training to separate features (CPU) from MF core (GPU).
 */
function computeFeatureContribution(
  rating: Rating,
  featureEmbeddings: Map<string, { vector: number[]; bias: number }>,
  featureDimensions: number
): number {
  let contribution = 0;
  const activeFeatures: { vector: number[]; bias: number }[] = [];

  // Movie feature biases
  for (const genreId of rating.movieFeatures.genreIds) {
    const emb = featureEmbeddings.get(getFeatureKey("genre", genreId));
    if (emb) { contribution += emb.bias * 0.5; activeFeatures.push(emb); }
  }
  if (rating.movieFeatures.era) {
    const emb = featureEmbeddings.get(getFeatureKey("era", rating.movieFeatures.era));
    if (emb) { contribution += emb.bias * 0.3; activeFeatures.push(emb); }
  }
  if (rating.movieFeatures.language) {
    const emb = featureEmbeddings.get(getFeatureKey("language", rating.movieFeatures.language));
    if (emb) { contribution += emb.bias * 0.2; activeFeatures.push(emb); }
  }
  if (rating.movieFeatures.originCountry) {
    const emb = featureEmbeddings.get(getFeatureKey("origin_country", rating.movieFeatures.originCountry));
    if (emb) { contribution += emb.bias * 0.15; activeFeatures.push(emb); }
  }
  for (const studioId of rating.movieFeatures.studioIds.slice(0, 2)) {
    const emb = featureEmbeddings.get(getFeatureKey("studio", studioId));
    if (emb) { contribution += emb.bias * 0.2; activeFeatures.push(emb); }
  }
  for (const actorId of rating.movieFeatures.actorIds.slice(0, 3)) {
    const emb = featureEmbeddings.get(getFeatureKey("actor", actorId));
    if (emb) { contribution += emb.bias * 0.15; activeFeatures.push(emb); }
  }
  for (const directorId of rating.movieFeatures.directorIds) {
    const emb = featureEmbeddings.get(getFeatureKey("director", directorId));
    if (emb) { contribution += emb.bias * 0.25; activeFeatures.push(emb); }
  }
  for (const { tag, relevance } of rating.movieFeatures.tags.slice(0, 8)) {
    const emb = featureEmbeddings.get(getFeatureKey("tag", tag));
    if (emb) { contribution += emb.bias * 0.15 * relevance; activeFeatures.push(emb); }
  }

  // Binned features
  const binFeatures: { type: FeatureType; id: string; weight: number }[] = [
    { type: "popularity_bin", id: rating.movieFeatures.popularityBin, weight: 0.1 },
    { type: "runtime_bin", id: rating.movieFeatures.runtimeBin, weight: 0.05 },
    { type: "vote_avg_bin", id: rating.movieFeatures.voteAvgBin, weight: 0.15 },
    { type: "vote_count_bin", id: rating.movieFeatures.voteCountBin, weight: 0.2 },
    { type: "surprise_factor_bin", id: rating.movieFeatures.surpriseFactorBin, weight: 0.1 },
  ];
  for (const { type, id, weight } of binFeatures) {
    const emb = featureEmbeddings.get(getFeatureKey(type, id));
    if (emb) { contribution += emb.bias * weight; activeFeatures.push(emb); }
  }

  // User features
  const explorationEmb = featureEmbeddings.get(getFeatureKey("user_exploration", binExploration(rating.userFeatures.explorationFactor)));
  if (explorationEmb) { contribution += explorationEmb.bias * 0.1; activeFeatures.push(explorationEmb); }
  const ratingPatternEmb = featureEmbeddings.get(getFeatureKey("user_rating_pattern", classifyRatingDisposition(rating.userFeatures.ratingMean, rating.userFeatures.ratingStdDev, rating.userFeatures.ratingCount)));
  if (ratingPatternEmb) { contribution += ratingPatternEmb.bias * 0.1; activeFeatures.push(ratingPatternEmb); }

  // Genre overlap bonus
  const genreOverlap = rating.movieFeatures.genreIds.filter((g) => rating.userFeatures.topGenreIds.includes(g)).length;
  if (genreOverlap > 0) contribution += genreOverlap * 0.1;

  // Household consensus
  if (rating.householdFeatures.consensusScore > 0) {
    const consensusBin = rating.householdFeatures.consensusScore > 3.5 ? "positive" : rating.householdFeatures.consensusScore < 2.5 ? "negative" : "neutral";
    const consensusEmb = featureEmbeddings.get(getFeatureKey("household_consensus", consensusBin));
    if (consensusEmb) { contribution += consensusEmb.bias * 0.2; activeFeatures.push(consensusEmb); }
    contribution += (rating.householdFeatures.consensusScore - 3) * 0.15;
  }

  // Pairwise feature interactions (top 5)
  if (activeFeatures.length > 1) {
    let interactionSum = 0;
    for (let i = 0; i < Math.min(activeFeatures.length, 5); i++) {
      for (let j = i + 1; j < Math.min(activeFeatures.length, 5); j++) {
        interactionSum += dotProduct(activeFeatures[i].vector, activeFeatures[j].vector);
      }
    }
    contribution += interactionSum * 0.05;
  }

  return contribution;
}

/**
 * Update feature embeddings for a single rating given the weighted error.
 */
function updateFeatureEmbeddings(
  rating: Rating,
  weightedError: number,
  featureEmbeddings: Map<string, { vector: number[]; bias: number }>,
  lr: number,
  reg: number,
  featureDims: number
): void {
  const keys: string[] = [];
  for (const genreId of rating.movieFeatures.genreIds) keys.push(getFeatureKey("genre", genreId));
  if (rating.movieFeatures.era) keys.push(getFeatureKey("era", rating.movieFeatures.era));
  for (const studioId of rating.movieFeatures.studioIds.slice(0, 2)) keys.push(getFeatureKey("studio", studioId));
  for (const actorId of rating.movieFeatures.actorIds.slice(0, 3)) keys.push(getFeatureKey("actor", actorId));
  for (const directorId of rating.movieFeatures.directorIds) keys.push(getFeatureKey("director", directorId));
  for (const { tag } of rating.movieFeatures.tags.slice(0, 8)) keys.push(getFeatureKey("tag", tag));
  keys.push(getFeatureKey("popularity_bin", rating.movieFeatures.popularityBin));
  keys.push(getFeatureKey("runtime_bin", rating.movieFeatures.runtimeBin));
  keys.push(getFeatureKey("vote_avg_bin", rating.movieFeatures.voteAvgBin));
  keys.push(getFeatureKey("vote_count_bin", rating.movieFeatures.voteCountBin));
  keys.push(getFeatureKey("surprise_factor_bin", rating.movieFeatures.surpriseFactorBin));
  keys.push(getFeatureKey("user_exploration", binExploration(rating.userFeatures.explorationFactor)));
  keys.push(getFeatureKey("user_rating_pattern", classifyRatingDisposition(rating.userFeatures.ratingMean, rating.userFeatures.ratingStdDev, rating.userFeatures.ratingCount)));

  for (const key of keys) {
    const emb = featureEmbeddings.get(key);
    if (emb) {
      emb.bias += lr * (weightedError * 0.1 - reg * emb.bias);
      for (let k = 0; k < featureDims; k++) {
        emb.vector[k] += lr * (weightedError * 0.05 - reg * emb.vector[k]);
      }
    }
  }
}

/**
 * Predict rating using the hybrid factorization machine
 */
function predictRating(
  userVector: number[],
  movieVector: number[],
  userBias: number,
  movieBias: number,
  globalMean: number,
  movieFeatures: MovieFeatures,
  userFeatures: UserFeatures,
  householdFeatures: HouseholdFeatures,
  featureEmbeddings: Map<string, { vector: number[]; bias: number }>,
  featureDimensions: number
): number {
  // Base prediction from user-movie interaction
  let prediction = globalMean + userBias + movieBias + dotProduct(userVector, movieVector);

  // Collect all active feature embeddings
  const activeFeatures: { vector: number[]; bias: number }[] = [];

  // Movie features
  for (const genreId of movieFeatures.genreIds) {
    const key = getFeatureKey("genre", genreId);
    const emb = featureEmbeddings.get(key);
    if (emb) {
      prediction += emb.bias * 0.5; // Genre bias contribution
      activeFeatures.push(emb);
    }
  }

  if (movieFeatures.era) {
    const emb = featureEmbeddings.get(getFeatureKey("era", movieFeatures.era));
    if (emb) {
      prediction += emb.bias * 0.3;
      activeFeatures.push(emb);
    }
  }

  if (movieFeatures.language) {
    const emb = featureEmbeddings.get(getFeatureKey("language", movieFeatures.language));
    if (emb) {
      prediction += emb.bias * 0.2;
      activeFeatures.push(emb);
    }
  }

  if (movieFeatures.originCountry) {
    const emb = featureEmbeddings.get(getFeatureKey("origin_country", movieFeatures.originCountry));
    if (emb) {
      prediction += emb.bias * 0.15;
      activeFeatures.push(emb);
    }
  }

  for (const studioId of movieFeatures.studioIds.slice(0, 2)) {
    const emb = featureEmbeddings.get(getFeatureKey("studio", studioId));
    if (emb) {
      prediction += emb.bias * 0.2;
      activeFeatures.push(emb);
    }
  }

  for (const actorId of movieFeatures.actorIds.slice(0, 3)) {
    const emb = featureEmbeddings.get(getFeatureKey("actor", actorId));
    if (emb) {
      prediction += emb.bias * 0.15;
      activeFeatures.push(emb);
    }
  }

  for (const directorId of movieFeatures.directorIds) {
    const emb = featureEmbeddings.get(getFeatureKey("director", directorId));
    if (emb) {
      prediction += emb.bias * 0.25;
      activeFeatures.push(emb);
    }
  }

  // Tag genome features (weighted by relevance)
  for (const { tag, relevance } of movieFeatures.tags.slice(0, 8)) {
    const emb = featureEmbeddings.get(getFeatureKey("tag", tag));
    if (emb) {
      prediction += emb.bias * 0.15 * relevance;
      activeFeatures.push(emb);
    }
  }

  // Binned features
  const binFeatures = [
    { type: "popularity_bin" as FeatureType, id: movieFeatures.popularityBin, weight: 0.1 },
    { type: "runtime_bin" as FeatureType, id: movieFeatures.runtimeBin, weight: 0.05 },
    { type: "vote_avg_bin" as FeatureType, id: movieFeatures.voteAvgBin, weight: 0.15 },
    { type: "vote_count_bin" as FeatureType, id: movieFeatures.voteCountBin, weight: 0.2 },
    { type: "surprise_factor_bin" as FeatureType, id: movieFeatures.surpriseFactorBin, weight: 0.1 },
  ];

  for (const { type, id, weight } of binFeatures) {
    const emb = featureEmbeddings.get(getFeatureKey(type, id));
    if (emb) {
      prediction += emb.bias * weight;
      activeFeatures.push(emb);
    }
  }

  // User features
  const explorationBin = binExploration(userFeatures.explorationFactor);
  const explorationEmb = featureEmbeddings.get(getFeatureKey("user_exploration", explorationBin));
  if (explorationEmb) {
    prediction += explorationEmb.bias * 0.1;
    activeFeatures.push(explorationEmb);
  }

  const ratingPatternBin = classifyRatingDisposition(userFeatures.ratingMean, userFeatures.ratingStdDev, userFeatures.ratingCount);
  const ratingPatternEmb = featureEmbeddings.get(getFeatureKey("user_rating_pattern", ratingPatternBin));
  if (ratingPatternEmb) {
    prediction += ratingPatternEmb.bias * 0.1;
    activeFeatures.push(ratingPatternEmb);
  }

  // User-genre interaction: boost if user's top genres match movie genres
  const genreOverlap = movieFeatures.genreIds.filter((g) =>
    userFeatures.topGenreIds.includes(g)
  ).length;
  if (genreOverlap > 0) {
    prediction += genreOverlap * 0.1; // Small bonus for genre match
  }

  // Household consensus feature
  if (householdFeatures.consensusScore > 0) {
    const consensusBin =
      householdFeatures.consensusScore > 3.5 ? "positive" : householdFeatures.consensusScore < 2.5 ? "negative" : "neutral";
    const consensusEmb = featureEmbeddings.get(getFeatureKey("household_consensus", consensusBin));
    if (consensusEmb) {
      prediction += consensusEmb.bias * 0.2;
      activeFeatures.push(consensusEmb);
    }
    // Direct influence from household consensus
    prediction += (householdFeatures.consensusScore - 3) * 0.15;
  }

  // Feature interaction terms (simplified: sum of pairwise dot products)
  // This captures things like "users who like action also like this director"
  if (activeFeatures.length > 1) {
    let interactionSum = 0;
    for (let i = 0; i < Math.min(activeFeatures.length, 5); i++) {
      for (let j = i + 1; j < Math.min(activeFeatures.length, 5); j++) {
        interactionSum += dotProduct(activeFeatures[i].vector, activeFeatures[j].vector);
      }
    }
    prediction += interactionSum * 0.05; // Small weight for interactions
  }

  // Clamp to valid rating range (1-5)
  return Math.max(1, Math.min(5, prediction));
}

/**
 * Load existing latent vectors and embeddings from database
 */
async function loadLatentVectors(featureDimensions: number): Promise<LatentVectors> {
  const [storedVectors, storedEmbeddings, metadata] = await Promise.all([
    prisma.latentVector.findMany(),
    prisma.featureEmbedding.findMany(),
    prisma.mFModelMetadata.findFirst(),
  ]);

  const userVectors = new Map<string, number[]>();
  const movieVectors = new Map<string, number[]>();
  const userBiases = new Map<string, number>();
  const movieBiases = new Map<string, number>();
  const featureEmbeddings = new Map<string, { vector: number[]; bias: number }>();

  for (const stored of storedVectors) {
    const vector = JSON.parse(stored.vector) as number[];
    if (stored.entityType === "user") {
      userVectors.set(stored.entityId, vector);
      userBiases.set(stored.entityId, stored.bias);
    } else if (stored.entityType === "movie") {
      movieVectors.set(stored.entityId, vector);
      movieBiases.set(stored.entityId, stored.bias);
    }
  }

  for (const stored of storedEmbeddings) {
    const key = getFeatureKey(stored.featureType as FeatureType, stored.featureId);
    featureEmbeddings.set(key, {
      vector: JSON.parse(stored.vector) as number[],
      bias: stored.bias,
    });
  }

  return {
    userVectors,
    movieVectors,
    userBiases,
    movieBiases,
    featureEmbeddings,
    globalMean: metadata?.globalMean ?? 3.0,
  };
}

/**
 * Save latent vectors and embeddings to database
 */
async function saveLatentVectors(vectors: LatentVectors): Promise<void> {
  const factories: (() => Promise<unknown>)[] = [];

  for (const [userId, vector] of vectors.userVectors) {
    factories.push(() =>
      prisma.latentVector.upsert({
        where: { entityType_entityId: { entityType: "user", entityId: userId } },
        create: {
          entityType: "user",
          entityId: userId,
          vector: JSON.stringify(vector),
          bias: vectors.userBiases.get(userId) ?? 0,
        },
        update: {
          vector: JSON.stringify(vector),
          bias: vectors.userBiases.get(userId) ?? 0,
        },
      })
    );
  }

  for (const [movieId, vector] of vectors.movieVectors) {
    factories.push(() =>
      prisma.latentVector.upsert({
        where: { entityType_entityId: { entityType: "movie", entityId: movieId } },
        create: {
          entityType: "movie",
          entityId: movieId,
          vector: JSON.stringify(vector),
          bias: vectors.movieBiases.get(movieId) ?? 0,
        },
        update: {
          vector: JSON.stringify(vector),
          bias: vectors.movieBiases.get(movieId) ?? 0,
        },
      })
    );
  }

  for (const [key, emb] of vectors.featureEmbeddings) {
    const [featureType, featureId] = key.split(":", 2);
    factories.push(() =>
      prisma.featureEmbedding.upsert({
        where: { featureType_featureId: { featureType, featureId } },
        create: {
          featureType,
          featureId,
          vector: JSON.stringify(emb.vector),
          bias: emb.bias,
        },
        update: {
          vector: JSON.stringify(emb.vector),
          bias: emb.bias,
        },
      })
    );
  }

  // Process in batches (factories are lazy, so promises start only when invoked)
  const batchSize = 100;
  for (let i = 0; i < factories.length; i += batchSize) {
    await Promise.all(factories.slice(i, i + batchSize).map((fn) => fn()));
  }
}

/**
 * Build feature cache for a user
 */
async function buildUserFeatureCache(userId: string): Promise<UserFeatures> {
  const [settings, genreRankings, movieRatings] = await Promise.all([
    prisma.userSettings.findUnique({ where: { userId } }),
    prisma.genreRanking.findMany({
      where: { userId },
      orderBy: { rank: "asc" },
      take: 5,
      select: { genreId: true },
    }),
    prisma.movieRating.findMany({
      where: { userId, rating: { not: null } },
      select: { rating: true },
    }),
  ]);

  const ratings = movieRatings.map((r) => r.rating!);
  const ratingMean = ratings.length > 0 ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 3.0;
  const ratingVariance =
    ratings.length > 1
      ? ratings.reduce((sum, r) => sum + Math.pow(r - ratingMean, 2), 0) / (ratings.length - 1)
      : 0;

  const stdDev = Math.sqrt(ratingVariance);
  return {
    explorationFactor: settings?.explorationFactor ?? 0.5,
    ratingMean,
    ratingStdDev: stdDev,
    ratingCount: ratings.length,
    topGenreIds: genreRankings.map((g) => g.genreId),
  };
}

/**
 * Train the hybrid factorization machine using SGD
 */
export async function trainMatrixFactorization(
  options: {
    epochs?: number;
    learningRate?: number;
    regularization?: number;
    latentDimensions?: number;
    featureDimensions?: number;
  } = {}
): Promise<{
  rmse: number;
  validationRmse: number;
  epochs: number;
  ratingsProcessed: number;
  usersProcessed: number;
  moviesProcessed: number;
  featuresLearned: number;
}> {
  const epochs = options.epochs ?? DEFAULT_EPOCHS;
  const learningRate = options.learningRate ?? DEFAULT_LEARNING_RATE;
  const regularization = options.regularization ?? DEFAULT_REGULARIZATION;
  const latentDimensions = options.latentDimensions ?? DEFAULT_LATENT_DIMENSIONS;
  const featureDimensions = options.featureDimensions ?? DEFAULT_FEATURE_DIMENSIONS;

  // Atomically acquire training lock to prevent TOCTOU race
  const metadata = await prisma.mFModelMetadata.findFirst();
  if (metadata) {
    const updated = await prisma.mFModelMetadata.updateMany({
      where: { id: metadata.id, isTraining: false },
      data: { isTraining: true },
    });
    if (updated.count === 0) {
      throw new Error("Model is already being trained");
    }
  } else {
    try {
      await prisma.mFModelMetadata.create({
        data: { id: "default", isTraining: true, latentDimensions, featureDimensions },
      });
    } catch {
      throw new Error("Model is already being trained");
    }
  }

  try {
    // Load all ratings with movie and user features
    const rawRatings = await prisma.movieRating.findMany({
      where: {
        rating: { not: null },
        notHeardOf: false,
      },
      select: {
        userId: true,
        movieId: true,
        rating: true,
        movie: {
          select: {
            id: true,
            era: true,
            originalLanguage: true,
            originCountry: true,
            surpriseFactor: true,
            popularity: true,
            runtime: true,
            voteAverage: true,
            voteCount: true,
            genres: { select: { genreId: true } },
            studios: { select: { studioId: true }, take: 3 },
            cast: { select: { personId: true }, take: 5, orderBy: { castOrder: "asc" } },
            crew: { where: { job: "Director" }, select: { personId: true }, take: 2 },
            movieTags: { select: { tag: true, relevance: true }, take: 10, orderBy: { relevance: "desc" } },
          },
        },
        user: {
          select: {
            id: true,
            householdMembers: {
              select: {
                household: {
                  select: {
                    members: {
                      select: { userId: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (rawRatings.length < MIN_RATINGS_TO_TRAIN) {
      throw new Error(`Need at least ${MIN_RATINGS_TO_TRAIN} ratings to train (have ${rawRatings.length})`);
    }

    // Build user feature cache
    const userIds = new Set(rawRatings.map((r) => r.userId));
    const userFeatureCache = new Map<string, UserFeatures>();
    for (const userId of userIds) {
      userFeatureCache.set(userId, await buildUserFeatureCache(userId));
    }

    // Cache user feature data to database for faster inference
    const cacheUpserts = Array.from(userFeatureCache.entries()).map(([userId, features]) => {
      const count = rawRatings.filter((r) => r.userId === userId).length;
      const disposition = classifyRatingDisposition(features.ratingMean, features.ratingStdDev, count);
      return prisma.userFeatureCache.upsert({
        where: { userId },
        create: {
          userId,
          explorationFactor: features.explorationFactor,
          ratingMean: features.ratingMean,
          ratingStdDev: features.ratingStdDev,
          ratingCount: count,
          ratingDisposition: disposition,
          topGenreIds: JSON.stringify(features.topGenreIds),
        },
        update: {
          explorationFactor: features.explorationFactor,
          ratingMean: features.ratingMean,
          ratingStdDev: features.ratingStdDev,
          ratingCount: count,
          ratingDisposition: disposition,
          topGenreIds: JSON.stringify(features.topGenreIds),
        },
      });
    });
    await Promise.all(cacheUpserts);

    // Build household rating lookup
    const householdMemberMap = new Map<string, Set<string>>(); // userId -> set of household member userIds
    for (const rating of rawRatings) {
      const memberSet = new Set<string>();
      for (const hm of rating.user.householdMembers) {
        for (const member of hm.household.members) {
          if (member.userId !== rating.userId) {
            memberSet.add(member.userId);
          }
        }
      }
      householdMemberMap.set(rating.userId, memberSet);
    }

    // Build movie rating lookup for household consensus
    const movieRatingLookup = new Map<string, Map<string, number>>(); // movieId -> (userId -> rating)
    for (const rating of rawRatings) {
      if (!movieRatingLookup.has(rating.movieId)) {
        movieRatingLookup.set(rating.movieId, new Map());
      }
      movieRatingLookup.get(rating.movieId)!.set(rating.userId, rating.rating!);
    }

    // Transform raw ratings to enriched format
    const ratings: Rating[] = rawRatings.map((r) => {
      const movieFeatures: MovieFeatures = {
        genreIds: r.movie.genres.map((g) => g.genreId),
        era: r.movie.era,
        language: r.movie.originalLanguage,
        originCountry: r.movie.originCountry,
        tags: (r.movie.movieTags ?? []).map((t) => ({ tag: t.tag, relevance: t.relevance })),
        studioIds: r.movie.studios.map((s) => s.studioId),
        actorIds: r.movie.cast.map((c) => c.personId),
        directorIds: r.movie.crew.map((c) => c.personId),
        popularityBin: binPopularity(r.movie.popularity),
        runtimeBin: binRuntime(r.movie.runtime),
        voteAvgBin: binVoteAverage(r.movie.voteAverage),
        voteCountBin: binVoteCount(r.movie.voteCount),
        surpriseFactorBin: binSurpriseFactor(r.movie.surpriseFactor),
      };

      const userFeatures = userFeatureCache.get(r.userId)!;

      // Calculate household consensus
      const householdMembers = householdMemberMap.get(r.userId) ?? new Set();
      const movieRatings = movieRatingLookup.get(r.movieId) ?? new Map();
      const otherUserRatings = new Map<string, number>();
      let consensusSum = 0;
      let consensusCount = 0;
      for (const memberId of householdMembers) {
        const memberRating = movieRatings.get(memberId);
        if (memberRating !== undefined) {
          otherUserRatings.set(memberId, memberRating);
          consensusSum += memberRating;
          consensusCount++;
        }
      }

      const householdFeatures: HouseholdFeatures = {
        otherUserRatings,
        consensusScore: consensusCount > 0 ? consensusSum / consensusCount : 0,
      };

      return {
        userId: r.userId,
        movieId: r.movieId,
        rating: normalizeRating(r.rating!, userFeatures.ratingMean, userFeatures.ratingStdDev),
        weight: 1.0,
        movieFeatures,
        userFeatures,
        householdFeatures,
      };
    });

    // ── Load ML community ratings for joint training ──
    // ML ratings are stored by imdbId (no FK to Movie) — map to local movieIds
    const mlRatingCount = await prisma.mLRating.count();
    let mlRatings: Rating[] = [];

    if (mlRatingCount > 0) {
      console.log(`[MF Train] Loading ML community ratings (${mlRatingCount} total in DB)...`);

      // Build imdbId → local movieId mapping
      const localMoviesForML = await prisma.movie.findMany({
        where: { imdbId: { not: null } },
        select: { id: true, imdbId: true },
      });
      const imdbToLocalId = new Map<string, string>();
      for (const m of localMoviesForML) {
        if (m.imdbId) imdbToLocalId.set(m.imdbId, m.id);
      }

      // Sample ML users to get complete preference profiles
      const allMLUserIds: { mlUserId: string }[] = await prisma.$queryRaw`
        SELECT "mlUserId" FROM (SELECT DISTINCT "mlUserId" FROM "MLRating") t ORDER BY random() LIMIT ${ML_SAMPLE_USERS}
      `;
      const sampledUserIds = allMLUserIds.map((u) => u.mlUserId);

      // Load their complete ratings
      const rawMLRatings = await prisma.mLRating.findMany({
        where: { mlUserId: { in: sampledUserIds } },
      });
      console.log(`[MF Train] Loaded ${rawMLRatings.length} ratings from ${sampledUserIds.length} ML users`);

      // Map imdbId → local movieId, skip ratings for movies not in local DB
      const mappedMLRatings = rawMLRatings
        .map((r) => ({ ...r, movieId: imdbToLocalId.get(r.imdbId) }))
        .filter((r): r is typeof r & { movieId: string } => r.movieId != null);
      console.log(`[MF Train] ${mappedMLRatings.length} ML ratings mapped to local movies (of ${rawMLRatings.length})`);

      // Compute per-ML-user stats for normalization and features
      const mlUserStats = new Map<string, { sum: number; sumSq: number; count: number }>();
      for (const r of mappedMLRatings) {
        if (!mlUserStats.has(r.mlUserId)) mlUserStats.set(r.mlUserId, { sum: 0, sumSq: 0, count: 0 });
        const stats = mlUserStats.get(r.mlUserId)!;
        stats.sum += r.rating;
        stats.sumSq += r.rating * r.rating;
        stats.count++;
      }

      // Build ML user feature profiles
      const mlUserFeatureCache = new Map<string, UserFeatures>();
      for (const [mlUserId, stats] of mlUserStats) {
        const mean = stats.sum / stats.count;
        const variance = stats.count > 1 ? (stats.sumSq / stats.count - mean * mean) : 0;
        mlUserFeatureCache.set(`ml_${mlUserId}`, {
          explorationFactor: 0.5,
          ratingMean: mean,
          ratingStdDev: Math.sqrt(Math.max(0, variance)),
          ratingCount: stats.count,
          topGenreIds: [], // No genre preference data for ML users
        });
      }

      // Load movie features for ML-rated movies not already loaded
      const householdMovieIds = new Set(rawRatings.map((r) => r.movieId));
      const mlOnlyMovieIds = [...new Set(mappedMLRatings.map((r) => r.movieId))].filter(
        (id) => !householdMovieIds.has(id)
      );

      const mlMovies =
        mlOnlyMovieIds.length > 0
          ? await prisma.movie.findMany({
              where: { id: { in: mlOnlyMovieIds } },
              select: {
                id: true,
                era: true,
                originalLanguage: true,
                originCountry: true,
                surpriseFactor: true,
                popularity: true,
                runtime: true,
                voteAverage: true,
                voteCount: true,
                genres: { select: { genreId: true } },
                studios: { select: { studioId: true }, take: 3 },
                cast: { select: { personId: true }, take: 5, orderBy: { castOrder: "asc" } },
                crew: { where: { job: "Director" }, select: { personId: true }, take: 2 },
                movieTags: { select: { tag: true, relevance: true }, take: 10, orderBy: { relevance: "desc" } },
              },
            })
          : [];

      // Build movie features map for ML movies + household movies
      const movieFeaturesMap = new Map<string, MovieFeatures>();
      // Add household movie features (already computed in ratings array)
      for (const r of ratings) {
        movieFeaturesMap.set(r.movieId, r.movieFeatures);
      }
      // Add ML-only movie features
      for (const m of mlMovies) {
        movieFeaturesMap.set(m.id, {
          genreIds: m.genres.map((g) => g.genreId),
          era: m.era,
          language: m.originalLanguage,
          originCountry: m.originCountry,
          tags: (m.movieTags ?? []).map((t) => ({ tag: t.tag, relevance: t.relevance })),
          studioIds: m.studios.map((s) => s.studioId),
          actorIds: m.cast.map((c) => c.personId),
          directorIds: m.crew.map((c) => c.personId),
          popularityBin: binPopularity(m.popularity),
          runtimeBin: binRuntime(m.runtime),
          voteAvgBin: binVoteAverage(m.voteAverage),
          voteCountBin: binVoteCount(m.voteCount),
          surpriseFactorBin: binSurpriseFactor(m.surpriseFactor),
        });
      }

      // Empty household features for ML users
      const emptyHouseholdFeatures: HouseholdFeatures = {
        otherUserRatings: new Map(),
        consensusScore: 0,
      };

      // Build ML Rating objects
      for (const r of mappedMLRatings) {
        const mf = movieFeaturesMap.get(r.movieId);
        if (!mf) continue;
        const uf = mlUserFeatureCache.get(`ml_${r.mlUserId}`);
        if (!uf) continue;

        mlRatings.push({
          userId: `ml_${r.mlUserId}`,
          movieId: r.movieId,
          rating: normalizeRating(r.rating, uf.ratingMean, uf.ratingStdDev),
          weight: ML_RATING_WEIGHT,
          movieFeatures: mf,
          userFeatures: uf,
          householdFeatures: emptyHouseholdFeatures,
        });
      }

      // Add ML user features to cache (for vector initialization)
      for (const [mlUserId, features] of mlUserFeatureCache) {
        userFeatureCache.set(mlUserId, features);
      }

      console.log(`[MF Train] Built ${mlRatings.length} ML training examples (weight: ${ML_RATING_WEIGHT})`);
    }

    // Combine household + ML ratings
    const allRatings = [...ratings, ...mlRatings];

    // Calculate global mean (of household normalized ratings only — ML has different scale)
    const globalMean = ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length;

    // Split HOUSEHOLD ratings into training and validation (validate on household only)
    const shuffled = [...ratings].sort(() => Math.random() - 0.5);
    const validationSize = Math.floor(shuffled.length * VALIDATION_SPLIT);
    const validationSet = shuffled.slice(0, validationSize);
    const householdTrainingSet = shuffled.slice(validationSize);

    // Combine household training + ML ratings for the full training set
    const trainingSet = [...householdTrainingSet, ...mlRatings];

    // Collect all unique features (from ALL ratings: household + ML)
    const allFeatures = new Set<string>();
    for (const r of allRatings) {
      for (const genreId of r.movieFeatures.genreIds) {
        allFeatures.add(getFeatureKey("genre", genreId));
      }
      if (r.movieFeatures.era) {
        allFeatures.add(getFeatureKey("era", r.movieFeatures.era));
      }
      for (const studioId of r.movieFeatures.studioIds) {
        allFeatures.add(getFeatureKey("studio", studioId));
      }
      for (const actorId of r.movieFeatures.actorIds) {
        allFeatures.add(getFeatureKey("actor", actorId));
      }
      for (const directorId of r.movieFeatures.directorIds) {
        allFeatures.add(getFeatureKey("director", directorId));
      }
      for (const { tag } of r.movieFeatures.tags) {
        allFeatures.add(getFeatureKey("tag", tag));
      }
      allFeatures.add(getFeatureKey("popularity_bin", r.movieFeatures.popularityBin));
      allFeatures.add(getFeatureKey("runtime_bin", r.movieFeatures.runtimeBin));
      allFeatures.add(getFeatureKey("vote_avg_bin", r.movieFeatures.voteAvgBin));
      allFeatures.add(getFeatureKey("vote_count_bin", r.movieFeatures.voteCountBin));
      allFeatures.add(getFeatureKey("surprise_factor_bin", r.movieFeatures.surpriseFactorBin));
      allFeatures.add(getFeatureKey("user_exploration", binExploration(r.userFeatures.explorationFactor)));
      allFeatures.add(getFeatureKey("user_rating_pattern", classifyRatingDisposition(r.userFeatures.ratingMean, r.userFeatures.ratingStdDev, r.userFeatures.ratingCount)));
      if (r.householdFeatures.consensusScore > 0) {
        const consensusBin = r.householdFeatures.consensusScore > 3.5 ? "positive" : r.householdFeatures.consensusScore < 2.5 ? "negative" : "neutral";
        allFeatures.add(getFeatureKey("household_consensus", consensusBin));
      }
    }

    // Get unique users and movies (from ALL ratings)
    const movieIds = new Set(allRatings.map((r) => r.movieId));

    // Load existing vectors or initialize new ones
    const existing = await loadLatentVectors(featureDimensions);

    const userVectors = new Map<string, number[]>();
    const movieVectors = new Map<string, number[]>();
    const userBiases = new Map<string, number>();
    const movieBiases = new Map<string, number>();
    const featureEmbeddings = new Map<string, { vector: number[]; bias: number }>();

    // Include ML user IDs
    const allUserIds = new Set([...userIds, ...allRatings.filter((r) => r.userId.startsWith("ml_")).map((r) => r.userId)]);

    // Initialize or reuse vectors (ML users always get fresh vectors — they're temporary)
    for (const userId of allUserIds) {
      const isMLUser = userId.startsWith("ml_");
      userVectors.set(userId, isMLUser ? initializeVector(latentDimensions) : (existing.userVectors.get(userId) ?? initializeVector(latentDimensions)));
      userBiases.set(userId, isMLUser ? 0 : (existing.userBiases.get(userId) ?? 0));
    }

    for (const movieId of movieIds) {
      movieVectors.set(movieId, existing.movieVectors.get(movieId) ?? initializeVector(latentDimensions));
      movieBiases.set(movieId, existing.movieBiases.get(movieId) ?? 0);
    }

    for (const featureKey of allFeatures) {
      const existingEmb = existing.featureEmbeddings.get(featureKey);
      featureEmbeddings.set(featureKey, existingEmb ?? {
        vector: initializeVector(featureDimensions),
        bias: 0,
      });
    }

    // Training loop — use GPU batch operations when tf.js is available
    const tfResult = await getTF();
    let rmse = 0;
    let validationRmse = 0;

    if (tfResult) {
      // ── GPU/BLAS-accelerated batch training ──
      const { tf, backend } = tfResult;
      const BATCH_SIZE = 32768;
      console.log(`[MF Train] Using TensorFlow.js (${backend}) with batch size ${BATCH_SIZE}`);

      // Build index mappings for tensor operations
      const userIdList = [...userVectors.keys()];
      const movieIdList = [...movieVectors.keys()];
      const userIdxMap = new Map(userIdList.map((id: string, i: number) => [id, i]));
      const movieIdxMap = new Map(movieIdList.map((id: string, i: number) => [id, i]));
      const numUsers = userIdList.length;
      const numMovies = movieIdList.length;

      // Create GPU tensors from Maps
      const uVecData = new Float32Array(numUsers * latentDimensions);
      for (let i = 0; i < numUsers; i++) {
        const vec = userVectors.get(userIdList[i])!;
        for (let d = 0; d < latentDimensions; d++) uVecData[i * latentDimensions + d] = vec[d];
      }
      const mVecData = new Float32Array(numMovies * latentDimensions);
      for (let i = 0; i < numMovies; i++) {
        const vec = movieVectors.get(movieIdList[i])!;
        for (let d = 0; d < latentDimensions; d++) mVecData[i * latentDimensions + d] = vec[d];
      }
      const uBiasData = new Float32Array(numUsers);
      for (let i = 0; i < numUsers; i++) uBiasData[i] = userBiases.get(userIdList[i])!;
      const mBiasData = new Float32Array(numMovies);
      for (let i = 0; i < numMovies; i++) mBiasData[i] = movieBiases.get(movieIdList[i])!;

      const uTensor = tf.variable(tf.tensor2d(uVecData, [numUsers, latentDimensions]));
      const mTensor = tf.variable(tf.tensor2d(mVecData, [numMovies, latentDimensions]));
      const uBiasTensor = tf.variable(tf.tensor1d(uBiasData));
      const mBiasTensor = tf.variable(tf.tensor1d(mBiasData));
      const lrScalar = tf.scalar(learningRate);
      const regScalar = tf.scalar(regularization);

      for (let epoch = 0; epoch < epochs; epoch++) {
        let epochTraining: Rating[];
        if (mlRatings.length > ML_SAMPLE_PER_EPOCH) {
          const sampledML = [...mlRatings].sort(() => Math.random() - 0.5).slice(0, ML_SAMPLE_PER_EPOCH);
          epochTraining = [...householdTrainingSet, ...sampledML];
        } else {
          epochTraining = trainingSet;
        }

        // Shuffle
        for (let i = epochTraining.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [epochTraining[i], epochTraining[j]] = [epochTraining[j], epochTraining[i]];
        }

        let totalSquaredError = 0;
        let householdCount = 0;

        for (let bStart = 0; bStart < epochTraining.length; bStart += BATCH_SIZE) {
          const batch = epochTraining.slice(bStart, Math.min(bStart + BATCH_SIZE, epochTraining.length));
          const B = batch.length;

          // CPU: pre-compute feature contributions for each rating
          const featContribs = new Float32Array(B);
          for (let i = 0; i < B; i++) {
            featContribs[i] = computeFeatureContribution(
              batch[i], featureEmbeddings, featureDimensions
            );
          }

          // Build batch index arrays
          const userIdxArr = new Int32Array(B);
          const movieIdxArr = new Int32Array(B);
          const targetArr = new Float32Array(B);
          const weightArr = new Float32Array(B);
          for (let i = 0; i < B; i++) {
            userIdxArr[i] = userIdxMap.get(batch[i].userId)!;
            movieIdxArr[i] = movieIdxMap.get(batch[i].movieId)!;
            targetArr[i] = batch[i].rating;
            weightArr[i] = batch[i].weight;
          }

          // GPU: batch MF prediction, error computation, and gradient updates
          const rawErrors = tf.tidy(() => {
            const userIdx = tf.tensor1d(userIdxArr, "int32");
            const movieIdx = tf.tensor1d(movieIdxArr, "int32");
            const targets = tf.tensor1d(targetArr);
            const weights = tf.tensor1d(weightArr);
            const featC = tf.tensor1d(featContribs);

            // Gather vectors for this batch
            const bUserVecs = tf.gather(uTensor, userIdx);     // [B, D]
            const bMovieVecs = tf.gather(mTensor, movieIdx);    // [B, D]
            const bUserBias = tf.gather(uBiasTensor, userIdx);  // [B]
            const bMovieBias = tf.gather(mBiasTensor, movieIdx); // [B]

            // Predict: dot(user, movie) + biases + globalMean + featureContribution
            const dots = tf.sum(tf.mul(bUserVecs, bMovieVecs), 1);
            const preds = dots.add(bUserBias).add(bMovieBias).add(globalMean).add(featC);

            // Errors
            const errors = targets.sub(preds);
            const wErrors = errors.mul(weights);

            // MF gradients: grad_user = wError * movieVec - reg * userVec
            const wErrorsExp = tf.expandDims(wErrors, 1); // [B, 1]
            const userGrads = tf.sub(tf.mul(wErrorsExp, bMovieVecs), tf.mul(regScalar, bUserVecs));
            const movieGrads = tf.sub(tf.mul(wErrorsExp, bUserVecs), tf.mul(regScalar, bMovieVecs));
            const userBiasGrads = tf.sub(wErrors, tf.mul(regScalar, bUserBias));
            const movieBiasGrads = tf.sub(wErrors, tf.mul(regScalar, bMovieBias));

            // Accumulate gradients per entity via segment sum
            const uGradAcc = tf.unsortedSegmentSum(userGrads, userIdx, numUsers);
            const mGradAcc = tf.unsortedSegmentSum(movieGrads, movieIdx, numMovies);
            const uBiasAcc = tf.unsortedSegmentSum(userBiasGrads, userIdx, numUsers);
            const mBiasAcc = tf.unsortedSegmentSum(movieBiasGrads, movieIdx, numMovies);

            // Apply gradient updates
            uTensor.assign(uTensor.add(tf.mul(lrScalar, uGradAcc)));
            mTensor.assign(mTensor.add(tf.mul(lrScalar, mGradAcc)));
            uBiasTensor.assign(uBiasTensor.add(tf.mul(lrScalar, uBiasAcc)));
            mBiasTensor.assign(mBiasTensor.add(tf.mul(lrScalar, mBiasAcc)));

            return errors; // keep alive for CPU-side feature updates
          });

          // Read errors back to CPU
          const errorArr = rawErrors.dataSync() as Float32Array;
          rawErrors.dispose();

          // CPU: update feature embeddings using errors
          for (let i = 0; i < B; i++) {
            const wError = errorArr[i] * batch[i].weight;
            updateFeatureEmbeddings(batch[i], wError, featureEmbeddings, learningRate, regularization, featureDimensions);

            if (batch[i].weight === 1.0) {
              totalSquaredError += errorArr[i] * errorArr[i];
              householdCount++;
            }
          }
        }

        rmse = householdCount > 0 ? Math.sqrt(totalSquaredError / householdCount) : 0;

        // Compute validation RMSE on last epoch or every 5th (sync vectors from GPU first)
        const isLogEpoch = epoch % 5 === 0 || epoch === epochs - 1;
        if (isLogEpoch && validationSet.length > 0) {
          // Sync current tensor state to Maps for validation
          const curUVecs = uTensor.dataSync() as Float32Array;
          const curMVecs = mTensor.dataSync() as Float32Array;
          const curUBias = uBiasTensor.dataSync() as Float32Array;
          const curMBias = mBiasTensor.dataSync() as Float32Array;

          let validationSquaredError = 0;
          for (const rating of validationSet) {
            const uIdx = userIdxMap.get(rating.userId);
            const mIdx = movieIdxMap.get(rating.movieId);
            if (uIdx === undefined || mIdx === undefined) continue;

            // Read vectors directly from typed arrays
            const uVec = Array.from(curUVecs.subarray(uIdx * latentDimensions, (uIdx + 1) * latentDimensions));
            const mVec = Array.from(curMVecs.subarray(mIdx * latentDimensions, (mIdx + 1) * latentDimensions));

            const predicted = predictRating(
              uVec, mVec, curUBias[uIdx], curMBias[mIdx], globalMean,
              rating.movieFeatures, rating.userFeatures, rating.householdFeatures,
              featureEmbeddings, featureDimensions
            );
            validationSquaredError += Math.pow(rating.rating - predicted, 2);
          }
          validationRmse = Math.sqrt(validationSquaredError / validationSet.length);
          console.log(`[MF Train] Epoch ${epoch + 1}/${epochs}: RMSE=${rmse.toFixed(4)} valRMSE=${validationRmse.toFixed(4)} (${backend})`);
        }
      }

      // Read final tensors back to Maps
      const finalUVecs = uTensor.dataSync() as Float32Array;
      const finalMVecs = mTensor.dataSync() as Float32Array;
      const finalUBias = uBiasTensor.dataSync() as Float32Array;
      const finalMBias = mBiasTensor.dataSync() as Float32Array;

      for (let i = 0; i < numUsers; i++) {
        const vec = new Array(latentDimensions);
        for (let d = 0; d < latentDimensions; d++) vec[d] = finalUVecs[i * latentDimensions + d];
        userVectors.set(userIdList[i], vec);
        userBiases.set(userIdList[i], finalUBias[i]);
      }
      for (let i = 0; i < numMovies; i++) {
        const vec = new Array(latentDimensions);
        for (let d = 0; d < latentDimensions; d++) vec[d] = finalMVecs[i * latentDimensions + d];
        movieVectors.set(movieIdList[i], vec);
        movieBiases.set(movieIdList[i], finalMBias[i]);
      }

      // Cleanup GPU tensors
      uTensor.dispose();
      mTensor.dispose();
      uBiasTensor.dispose();
      mBiasTensor.dispose();
      lrScalar.dispose();
      regScalar.dispose();

      console.log(`[MF Train] GPU/BLAS training complete: ${epochs} epochs, RMSE=${rmse.toFixed(4)}`);
    } else {
      // ── Pure JavaScript fallback (no tf.js) ──
      console.log(`[MF Train] Using pure JS training loop`);

      for (let epoch = 0; epoch < epochs; epoch++) {
        let epochTraining: Rating[];
        if (mlRatings.length > ML_SAMPLE_PER_EPOCH) {
          const sampledML = [...mlRatings].sort(() => Math.random() - 0.5).slice(0, ML_SAMPLE_PER_EPOCH);
          epochTraining = [...householdTrainingSet, ...sampledML];
        } else {
          epochTraining = trainingSet;
        }

        // Fisher-Yates shuffle
        for (let i = epochTraining.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [epochTraining[i], epochTraining[j]] = [epochTraining[j], epochTraining[i]];
        }

        let totalSquaredError = 0;
        let householdCount = 0;

        for (const rating of epochTraining) {
          const userVector = userVectors.get(rating.userId)!;
          const movieVector = movieVectors.get(rating.movieId)!;
          const userBias = userBiases.get(rating.userId)!;
          const movieBias = movieBiases.get(rating.movieId)!;

          const predicted = predictRating(
            userVector, movieVector, userBias, movieBias, globalMean,
            rating.movieFeatures, rating.userFeatures, rating.householdFeatures,
            featureEmbeddings, featureDimensions
          );
          const error = rating.rating - predicted;
          const weightedError = error * rating.weight;

          if (rating.weight === 1.0) {
            totalSquaredError += error * error;
            householdCount++;
          }

          userBiases.set(rating.userId, userBias + learningRate * (weightedError - regularization * userBias));
          movieBiases.set(rating.movieId, movieBias + learningRate * (weightedError - regularization * movieBias));

          for (let k = 0; k < latentDimensions; k++) {
            const userK = userVector[k];
            const movieK = movieVector[k];
            userVector[k] += learningRate * (weightedError * movieK - regularization * userK);
            movieVector[k] += learningRate * (weightedError * userK - regularization * movieK);
          }

          updateFeatureEmbeddings(rating, weightedError, featureEmbeddings, learningRate, regularization, featureDimensions);
        }

        rmse = householdCount > 0 ? Math.sqrt(totalSquaredError / householdCount) : 0;

        let validationSquaredError = 0;
        for (const rating of validationSet) {
          const userVector = userVectors.get(rating.userId);
          const movieVector = movieVectors.get(rating.movieId);
          if (!userVector || !movieVector) continue;

          const predicted = predictRating(
            userVector, movieVector,
            userBiases.get(rating.userId) ?? 0,
            movieBiases.get(rating.movieId) ?? 0,
            globalMean,
            rating.movieFeatures, rating.userFeatures, rating.householdFeatures,
            featureEmbeddings, featureDimensions
          );
          validationSquaredError += Math.pow(rating.rating - predicted, 2);
        }
        validationRmse = validationSet.length > 0 ? Math.sqrt(validationSquaredError / validationSet.length) : rmse;

        if (epoch % 5 === 0 || epoch === epochs - 1) {
          console.log(`[MF Train] Epoch ${epoch + 1}/${epochs}: RMSE=${rmse.toFixed(4)} valRMSE=${validationRmse.toFixed(4)} (JS)`);
        }
      }
    }

    // Save trained vectors (exclude ML user vectors — they're temporary training aids)
    const householdUserVectors = new Map<string, number[]>();
    const householdUserBiases = new Map<string, number>();
    for (const [userId, vec] of userVectors) {
      if (!userId.startsWith("ml_")) {
        householdUserVectors.set(userId, vec);
        householdUserBiases.set(userId, userBiases.get(userId) ?? 0);
      }
    }

    // Cluster ML users into viewer archetypes (before discarding ML vectors)
    if (mlRatings.length > 0) {
      await clusterAndSaveArchetypes(userVectors, householdUserVectors, mlRatings, userFeatureCache);
    }

    await saveLatentVectors({
      userVectors: householdUserVectors,
      movieVectors,
      userBiases: householdUserBiases,
      movieBiases,
      featureEmbeddings,
      globalMean,
    });

    console.log(
      `[MF Train] Saved: ${householdUserVectors.size} household users, ${movieVectors.size} movies, ${featureEmbeddings.size} features` +
        (mlRatings.length > 0 ? ` (trained with ${mlRatings.length} ML ratings from ${allUserIds.size - userIds.size} ML users)` : "")
    );

    // Compute per-movie surprise factors (belief calibration)
    await computeSurpriseFactors(rawRatings, featureEmbeddings, globalMean, featureDimensions);

    // Update metadata
    const existingMetadata = await prisma.mFModelMetadata.findFirst();
    await prisma.mFModelMetadata.upsert({
      where: { id: existingMetadata?.id ?? "default" },
      create: {
        id: "default",
        version: 1,
        latentDimensions,
        featureDimensions,
        learningRate,
        regularization,
        trainedEpochs: epochs,
        totalRatings: ratings.length,
        rmse,
        validationRmse,
        globalMean,
        lastTrainedAt: new Date(),
        isTraining: false,
      },
      update: {
        version: { increment: 1 },
        trainedEpochs: { increment: epochs },
        totalRatings: ratings.length,
        rmse,
        validationRmse,
        globalMean,
        lastTrainedAt: new Date(),
        isTraining: false,
      },
    });

    return {
      rmse,
      validationRmse,
      epochs,
      ratingsProcessed: allRatings.length,
      usersProcessed: allUserIds.size,
      moviesProcessed: movieIds.size,
      featuresLearned: allFeatures.size,
    };
  } catch (error) {
    // Mark as not training on error
    const existingMetadata = await prisma.mFModelMetadata.findFirst();
    if (existingMetadata) {
      await prisma.mFModelMetadata.update({
        where: { id: existingMetadata.id },
        data: { isTraining: false },
      });
    }
    throw error;
  }
}

/**
 * Get predicted rating for a user-movie pair using the trained model
 */
export async function getPredictedRating(
  userId: string,
  movieId: string
): Promise<number | null> {
  const predictions = await getPredictedRatingsForUser(userId, [movieId]);
  return predictions.get(movieId) ?? null;
}

/**
 * Predict rating for a cold-start movie using only feature embeddings
 * This is used when a movie has no latent vector (hasn't been rated by anyone)
 */
function predictColdStartRating(
  userVector: number[],
  userBias: number,
  globalMean: number,
  movieFeatures: MovieFeatures,
  userFeatures: UserFeatures,
  featureEmbeddings: Map<string, { vector: number[]; bias: number }>,
  featureDimensions: number
): number {
  // Start with global mean and user bias only
  let prediction = globalMean + userBias;

  // Sum up all feature biases with weights
  const activeVectors: number[][] = [];

  // Genre features - strongest signal for cold start
  for (const genreId of movieFeatures.genreIds) {
    const emb = featureEmbeddings.get(getFeatureKey("genre", genreId));
    if (emb) {
      prediction += emb.bias * 0.6; // Higher weight for cold start
      activeVectors.push(emb.vector);
    }
  }

  // Era feature
  if (movieFeatures.era) {
    const emb = featureEmbeddings.get(getFeatureKey("era", movieFeatures.era));
    if (emb) {
      prediction += emb.bias * 0.4;
      activeVectors.push(emb.vector);
    }
  }

  // Language feature
  if (movieFeatures.language) {
    const emb = featureEmbeddings.get(getFeatureKey("language", movieFeatures.language));
    if (emb) {
      prediction += emb.bias * 0.3;
      activeVectors.push(emb.vector);
    }
  }

  // Origin country feature
  if (movieFeatures.originCountry) {
    const emb = featureEmbeddings.get(getFeatureKey("origin_country", movieFeatures.originCountry));
    if (emb) {
      prediction += emb.bias * 0.2;
      activeVectors.push(emb.vector);
    }
  }

  // Tag genome features — especially valuable for cold start
  for (const { tag, relevance } of movieFeatures.tags.slice(0, 8)) {
    const emb = featureEmbeddings.get(getFeatureKey("tag", tag));
    if (emb) {
      prediction += emb.bias * 0.25 * relevance;
      activeVectors.push(emb.vector);
    }
  }

  // Director features - important for cold start
  for (const directorId of movieFeatures.directorIds) {
    const emb = featureEmbeddings.get(getFeatureKey("director", directorId));
    if (emb) {
      prediction += emb.bias * 0.5;
      activeVectors.push(emb.vector);
    }
  }

  // Actor features
  for (const actorId of movieFeatures.actorIds.slice(0, 3)) {
    const emb = featureEmbeddings.get(getFeatureKey("actor", actorId));
    if (emb) {
      prediction += emb.bias * 0.3;
      activeVectors.push(emb.vector);
    }
  }

  // Studio features
  for (const studioId of movieFeatures.studioIds.slice(0, 2)) {
    const emb = featureEmbeddings.get(getFeatureKey("studio", studioId));
    if (emb) {
      prediction += emb.bias * 0.35;
      activeVectors.push(emb.vector);
    }
  }

  // Quality/popularity bins - extra important for cold start
  const binFeatures = [
    { type: "popularity_bin" as FeatureType, id: movieFeatures.popularityBin, weight: 0.15 },
    { type: "runtime_bin" as FeatureType, id: movieFeatures.runtimeBin, weight: 0.08 },
    { type: "vote_avg_bin" as FeatureType, id: movieFeatures.voteAvgBin, weight: 0.25 },
    { type: "vote_count_bin" as FeatureType, id: movieFeatures.voteCountBin, weight: 0.25 },
    { type: "surprise_factor_bin" as FeatureType, id: movieFeatures.surpriseFactorBin, weight: 0.15 },
  ];

  for (const { type, id, weight } of binFeatures) {
    const emb = featureEmbeddings.get(getFeatureKey(type, id));
    if (emb) {
      prediction += emb.bias * weight;
      activeVectors.push(emb.vector);
    }
  }

  // User features
  const explorationEmb = featureEmbeddings.get(
    getFeatureKey("user_exploration", binExploration(userFeatures.explorationFactor))
  );
  if (explorationEmb) {
    prediction += explorationEmb.bias * 0.15;
    activeVectors.push(explorationEmb.vector);
  }

  const ratingPatternEmb = featureEmbeddings.get(
    getFeatureKey("user_rating_pattern", classifyRatingDisposition(userFeatures.ratingMean, userFeatures.ratingStdDev, userFeatures.ratingCount))
  );
  if (ratingPatternEmb) {
    prediction += ratingPatternEmb.bias * 0.15;
    activeVectors.push(ratingPatternEmb.vector);
  }

  // Genre overlap bonus
  const genreOverlap = movieFeatures.genreIds.filter((g) =>
    userFeatures.topGenreIds.includes(g)
  ).length;
  if (genreOverlap > 0) {
    prediction += genreOverlap * 0.15;
  }

  // Synthesize a pseudo-movie-vector from feature embeddings
  // This allows user-feature interaction even for cold-start movies
  if (activeVectors.length > 0 && userVector.length > 0) {
    // Average the feature vectors to create a synthetic movie representation
    const syntheticMovieVec = new Array(featureDimensions).fill(0);
    for (const vec of activeVectors) {
      for (let i = 0; i < Math.min(vec.length, featureDimensions); i++) {
        syntheticMovieVec[i] += vec[i] / activeVectors.length;
      }
    }

    // Project user vector to feature dimension space (take first featureDimensions)
    const userProjected = userVector.slice(0, featureDimensions);
    while (userProjected.length < featureDimensions) {
      userProjected.push(0);
    }

    // Add interaction term
    prediction += dotProduct(userProjected, syntheticMovieVec) * 0.3;
  }

  return Math.max(1, Math.min(5, prediction));
}

/**
 * Get predicted ratings for multiple movies for a user (batch)
 * Handles both warm movies (with latent vectors) and cold-start movies (feature-only)
 */
export async function getPredictedRatingsForUser(
  userId: string,
  movieIds: string[]
): Promise<Map<string, number>> {
  const predictions = new Map<string, number>();

  const [userVector, movieVectors, featureEmbeddings, userCache, movies, metadata] = await Promise.all([
    prisma.latentVector.findUnique({
      where: { entityType_entityId: { entityType: "user", entityId: userId } },
    }),
    prisma.latentVector.findMany({
      where: { entityType: "movie", entityId: { in: movieIds } },
    }),
    prisma.featureEmbedding.findMany(),
    prisma.userFeatureCache.findUnique({ where: { userId } }),
    prisma.movie.findMany({
      where: { id: { in: movieIds } },
      select: {
        id: true,
        era: true,
        originalLanguage: true,
        originCountry: true,
        surpriseFactor: true,
        popularity: true,
        runtime: true,
        voteAverage: true,
        voteCount: true,
        genres: { select: { genreId: true } },
        studios: { select: { studioId: true }, take: 3 },
        cast: { select: { personId: true }, take: 5, orderBy: { castOrder: "asc" } },
        crew: { where: { job: "Director" }, select: { personId: true }, take: 2 },
        movieTags: { select: { tag: true, relevance: true }, take: 10, orderBy: { relevance: "desc" } },
      },
    }),
    prisma.mFModelMetadata.findFirst(),
  ]);

  // Build feature embedding map (needed for both warm and cold-start)
  const featureEmbeddingMap = new Map<string, { vector: number[]; bias: number }>();
  for (const emb of featureEmbeddings) {
    const key = getFeatureKey(emb.featureType as FeatureType, emb.featureId);
    featureEmbeddingMap.set(key, {
      vector: JSON.parse(emb.vector) as number[],
      bias: emb.bias,
    });
  }

  // If no feature embeddings, can't make any predictions
  if (featureEmbeddingMap.size === 0) {
    return predictions;
  }

  const globalMean = metadata?.globalMean ?? 3.0;
  const featureDimensions = metadata?.featureDimensions ?? DEFAULT_FEATURE_DIMENSIONS;
  const latentDimensions = metadata?.latentDimensions ?? DEFAULT_LATENT_DIMENSIONS;

  // User features (used for both warm and cold-start)
  const userFeatures: UserFeatures = {
    explorationFactor: userCache?.explorationFactor ?? 0.5,
    ratingMean: userCache?.ratingMean ?? 3.0,
    ratingStdDev: userCache?.ratingStdDev ?? 1.0,
    ratingCount: userCache?.ratingCount ?? 0,
    topGenreIds: userCache?.topGenreIds ? JSON.parse(userCache.topGenreIds) : [],
  };

  // Empty household features for prediction
  const householdFeatures: HouseholdFeatures = {
    otherUserRatings: new Map(),
    consensusScore: 0,
  };

  // Get user vector (may be null for cold-start users)
  const userVec = userVector ? JSON.parse(userVector.vector) as number[] : null;
  const userBias = userVector?.bias ?? 0;

  // Build movie vector map
  const movieVectorMap = new Map<string, { vector: number[]; bias: number }>();
  for (const mv of movieVectors) {
    movieVectorMap.set(mv.entityId, {
      vector: JSON.parse(mv.vector) as number[],
      bias: mv.bias,
    });
  }

  for (const movie of movies) {
    const movieFeatures: MovieFeatures = {
      genreIds: movie.genres.map((g) => g.genreId),
      era: movie.era,
      language: movie.originalLanguage,
      originCountry: movie.originCountry,
      tags: (movie.movieTags ?? []).map((t) => ({ tag: t.tag, relevance: t.relevance })),
      studioIds: movie.studios.map((s) => s.studioId),
      actorIds: movie.cast.map((c) => c.personId),
      directorIds: movie.crew.map((c) => c.personId),
      popularityBin: binPopularity(movie.popularity),
      runtimeBin: binRuntime(movie.runtime),
      voteAvgBin: binVoteAverage(movie.voteAverage),
      voteCountBin: binVoteCount(movie.voteCount),
      surpriseFactorBin: binSurpriseFactor(movie.surpriseFactor),
    };

    const movieVec = movieVectorMap.get(movie.id);

    if (movieVec && userVec) {
      // WARM PATH: Both user and movie have latent vectors
      const predicted = predictRating(
        userVec,
        movieVec.vector,
        userBias,
        movieVec.bias,
        globalMean,
        movieFeatures,
        userFeatures,
        householdFeatures,
        featureEmbeddingMap,
        featureDimensions
      );
      predictions.set(movie.id, predicted);
    } else if (userVec) {
      // COLD-START MOVIE: Movie has no latent vector, use feature-only prediction
      const predicted = predictColdStartRating(
        userVec,
        userBias,
        globalMean,
        movieFeatures,
        userFeatures,
        featureEmbeddingMap,
        featureDimensions
      );
      predictions.set(movie.id, predicted);
    } else {
      // COLD-START USER: No user vector, can still use feature biases
      // This gives a content-based fallback
      let prediction = globalMean;

      // Apply feature biases
      for (const genreId of movieFeatures.genreIds) {
        const emb = featureEmbeddingMap.get(getFeatureKey("genre", genreId));
        if (emb) prediction += emb.bias * 0.4;
      }

      const voteEmb = featureEmbeddingMap.get(getFeatureKey("vote_avg_bin", movieFeatures.voteAvgBin));
      if (voteEmb) prediction += voteEmb.bias * 0.3;

      const voteCountEmb = featureEmbeddingMap.get(getFeatureKey("vote_count_bin", movieFeatures.voteCountBin));
      if (voteCountEmb) prediction += voteCountEmb.bias * 0.25;

      const popEmb = featureEmbeddingMap.get(getFeatureKey("popularity_bin", movieFeatures.popularityBin));
      if (popEmb) prediction += popEmb.bias * 0.15;

      predictions.set(movie.id, Math.max(1, Math.min(5, prediction)));
    }
  }

  return predictions;
}

/**
 * Get model metadata including accuracy metrics
 */
export async function getModelMetadata(): Promise<{
  version: number;
  trainedEpochs: number;
  totalRatings: number;
  rmse: number | null;
  validationRmse: number | null;
  lastTrainedAt: Date | null;
  isTraining: boolean;
  confidence: number;
  featuresLearned: number;
} | null> {
  const [metadata, featureCount] = await Promise.all([
    prisma.mFModelMetadata.findFirst(),
    prisma.featureEmbedding.count(),
  ]);

  if (!metadata) return null;

  // Calculate confidence based on:
  // - Number of ratings (more = better)
  // - RMSE (lower = better)
  // - Validation RMSE (lower = better, indicates generalization)
  // - Number of epochs trained
  // - Number of features learned
  const ratingConfidence = Math.min(1, metadata.totalRatings / 100);
  const rmseConfidence = metadata.rmse ? Math.max(0, 1 - (metadata.rmse - 0.5) / 1.5) : 0;
  const validationConfidence = metadata.validationRmse
    ? Math.max(0, 1 - (metadata.validationRmse - 0.5) / 1.5)
    : rmseConfidence;
  const epochConfidence = Math.min(1, metadata.trainedEpochs / 50);
  const featureConfidence = Math.min(1, featureCount / 100);

  const confidence =
    ratingConfidence * 0.3 +
    rmseConfidence * 0.2 +
    validationConfidence * 0.25 +
    epochConfidence * 0.15 +
    featureConfidence * 0.1;

  return {
    version: metadata.version,
    trainedEpochs: metadata.trainedEpochs,
    totalRatings: metadata.totalRatings,
    rmse: metadata.rmse,
    validationRmse: metadata.validationRmse,
    lastTrainedAt: metadata.lastTrainedAt,
    isTraining: metadata.isTraining,
    confidence: Math.max(0, Math.min(1, confidence)),
    featuresLearned: featureCount,
  };
}

/**
 * Check if retraining is needed based on new ratings since last training
 */
export async function shouldRetrain(): Promise<boolean> {
  const metadata = await prisma.mFModelMetadata.findFirst();

  // If currently training, don't start another training
  if (metadata?.isTraining) {
    return false;
  }

  // If no model exists yet, check if we have enough ratings for initial training
  if (!metadata || !metadata.lastTrainedAt) {
    const ratingCount = await prisma.movieRating.count({
      where: { rating: { not: null }, notHeardOf: false },
    });
    return ratingCount >= MIN_RATINGS_TO_TRAIN;
  }

  const newRatingsCount = await prisma.movieRating.count({
    where: {
      rating: { not: null },
      notHeardOf: false,
      updatedAt: { gt: metadata.lastTrainedAt },
    },
  });

  const threshold = Math.max(10, Math.floor(metadata.totalRatings * 0.1));
  return newRatingsCount >= threshold;
}

/**
 * Log user activity for inactivity-based retraining
 */
export async function logActivity(
  userId: string | null,
  action: string,
  entityType?: string,
  entityId?: string
): Promise<void> {
  await prisma.activityLog.create({
    data: { userId, action, entityType, entityId },
  });

  // Cleanup old activity logs
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await prisma.activityLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
}

/**
 * Check if system has been inactive for specified duration
 */
export async function isSystemInactive(durationMinutes: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - durationMinutes * 60 * 1000);

  const recentActivity = await prisma.activityLog.findFirst({
    where: { createdAt: { gt: cutoff } },
    orderBy: { createdAt: "desc" },
  });

  return !recentActivity;
}

/**
 * Compute per-movie surprise factors (belief calibration).
 * Compares average satisfaction (hasSeen=true ratings) vs average willingness (hasSeen=false ratings).
 * For movies with only one type, falls back to average rating vs feature-based prediction.
 */
async function computeSurpriseFactors(
  rawRatings: { userId: string; movieId: string; rating: number | null; movie: { id: string } }[],
  featureEmbeddings: Map<string, { vector: number[]; bias: number }>,
  globalMean: number,
  featureDimensions: number,
): Promise<void> {
  // Load hasSeen status for all ratings
  const ratingsWithSeen = await prisma.movieRating.findMany({
    where: { rating: { not: null }, notHeardOf: false },
    select: { movieId: true, rating: true, hasSeen: true },
  });

  // Group by movie
  const movieRatings = new Map<string, { seen: number[]; unseen: number[] }>();
  for (const r of ratingsWithSeen) {
    if (!movieRatings.has(r.movieId)) {
      movieRatings.set(r.movieId, { seen: [], unseen: [] });
    }
    const group = movieRatings.get(r.movieId)!;
    if (r.hasSeen) {
      group.seen.push(r.rating!);
    } else {
      group.unseen.push(r.rating!);
    }
  }

  // Compute surprise factors
  const updates: { movieId: string; surpriseFactor: number }[] = [];

  for (const [movieId, { seen, unseen }] of movieRatings) {
    const totalRatings = seen.length + unseen.length;
    if (totalRatings < 3) continue;

    let surpriseFactor: number;

    if (seen.length >= 2 && unseen.length >= 2) {
      // Best case: compare satisfaction vs willingness
      const seenAvg = seen.reduce((a, b) => a + b, 0) / seen.length;
      const unseenAvg = unseen.reduce((a, b) => a + b, 0) / unseen.length;
      surpriseFactor = seenAvg - unseenAvg;
    } else {
      // Fallback: compare all ratings vs global mean (no directional signal)
      const allRatings = [...seen, ...unseen];
      const avg = allRatings.reduce((a, b) => a + b, 0) / allRatings.length;
      surpriseFactor = avg - globalMean;
    }

    updates.push({ movieId, surpriseFactor });
  }

  // Batch update
  const SURPRISE_BATCH = 100;
  for (let i = 0; i < updates.length; i += SURPRISE_BATCH) {
    const batch = updates.slice(i, i + SURPRISE_BATCH);
    await Promise.all(
      batch.map((u) =>
        prisma.movie.update({
          where: { id: u.movieId },
          data: { surpriseFactor: u.surpriseFactor },
        })
      )
    );
  }

  console.log(`[MF Train] Computed surprise factors for ${updates.length} movies`);
}

// ── Viewer Archetype Clustering ──

interface ClusterResult {
  centroid: number[];
  memberIds: string[];
}

function euclideanDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * K-means clustering on user latent vectors.
 * Returns cluster centroids and member assignments.
 */
function kMeansClustering(
  vectors: Map<string, number[]>,
  k: number,
  iterations: number = 20
): ClusterResult[] {
  const ids = Array.from(vectors.keys());
  if (ids.length < k) return [];

  const dims = vectors.get(ids[0])!.length;

  // Initialize centroids by random selection (k-means++)
  const shuffled = [...ids].sort(() => Math.random() - 0.5);
  const centroids: number[][] = shuffled.slice(0, k).map((id) => [...vectors.get(id)!]);

  const assignments = new Map<string, number>();

  for (let iter = 0; iter < iterations; iter++) {
    // Assignment step
    for (const id of ids) {
      const vec = vectors.get(id)!;
      let minDist = Infinity;
      let best = 0;
      for (let c = 0; c < k; c++) {
        const dist = euclideanDistance(vec, centroids[c]);
        if (dist < minDist) {
          minDist = dist;
          best = c;
        }
      }
      assignments.set(id, best);
    }

    // Update step
    for (let c = 0; c < k; c++) {
      const members = ids.filter((id) => assignments.get(id) === c);
      if (members.length === 0) continue;
      const newCentroid = new Array(dims).fill(0);
      for (const id of members) {
        const vec = vectors.get(id)!;
        for (let d = 0; d < dims; d++) {
          newCentroid[d] += vec[d] / members.length;
        }
      }
      centroids[c] = newCentroid;
    }
  }

  // Build results, filter tiny clusters
  const results: ClusterResult[] = [];
  for (let c = 0; c < k; c++) {
    const members = ids.filter((id) => assignments.get(id) === c);
    if (members.length >= 50) {
      results.push({ centroid: centroids[c], memberIds: members });
    }
  }
  return results;
}

interface ArchetypeAnalysis {
  name: string;
  description: string;
  topGenres: { name: string; score: number }[];
  disposition: string;
  traits: string[];
}

/**
 * Analyze a cluster's characteristics from its members' ratings and features.
 */
function analyzeCluster(
  cluster: ClusterResult,
  mlRatings: Rating[],
  userFeatureCache: Map<string, UserFeatures>,
  genreIdToName: Map<string, string>
): ArchetypeAnalysis {
  const memberSet = new Set(cluster.memberIds);

  // Aggregate user stats
  let totalMean = 0;
  let totalStdDev = 0;
  let featureCount = 0;
  for (const id of cluster.memberIds) {
    const uf = userFeatureCache.get(id);
    if (uf) {
      totalMean += uf.ratingMean;
      totalStdDev += uf.ratingStdDev;
      featureCount++;
    }
  }
  const avgMean = featureCount > 0 ? totalMean / featureCount : 3.0;
  const avgStdDev = featureCount > 0 ? totalStdDev / featureCount : 0.8;

  // Disposition of the cluster
  const disposition = classifyRatingDisposition(avgMean, avgStdDev, 100);

  // Count genres from cluster members' ratings (only above-average ratings)
  const genreCounts = new Map<string, number>();
  let totalGenreHits = 0;
  for (const r of mlRatings) {
    if (!memberSet.has(r.userId)) continue;
    if (r.rating < 0) continue; // normalized ratings: > 0 means above user's mean
    for (const gid of r.movieFeatures.genreIds) {
      genreCounts.set(gid, (genreCounts.get(gid) || 0) + 1);
      totalGenreHits++;
    }
  }

  const topGenres = Array.from(genreCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([gid, count]) => ({
      name: genreIdToName.get(gid) || "Unknown",
      score: totalGenreHits > 0 ? count / totalGenreHits : 0,
    }));

  // Generate name and traits
  const { name, description, traits } = nameArchetype(topGenres, disposition, avgMean, avgStdDev);

  return { name, description, topGenres, disposition, traits };
}

/**
 * Generate archetype name, description, and traits from cluster characteristics.
 */
function nameArchetype(
  topGenres: { name: string; score: number }[],
  disposition: string,
  avgMean: number,
  avgStdDev: number
): { name: string; description: string; traits: string[] } {
  const traits: string[] = [];

  // Rating behavior traits
  if (avgMean >= 3.5) {
    traits.push("Tends to rate movies generously");
  } else if (avgMean < 2.7) {
    traits.push("Critical viewer with high standards");
  } else {
    traits.push("Balanced perspective on films");
  }

  if (avgStdDev > 0.9) {
    traits.push("Strong opinions — loves or hates movies");
  } else if (avgStdDev < 0.6) {
    traits.push("Consistent ratings with little variation");
  } else {
    traits.push("Moderate range of ratings");
  }

  const primary = topGenres[0]?.name || "Drama";
  const secondary = topGenres[1]?.name || "";

  // Genre-based trait
  const genreTraitMap: Record<string, string> = {
    Action: "Drawn to high-energy spectacle",
    Adventure: "Loves epic journeys and discovery",
    Animation: "Appreciates animated storytelling",
    Comedy: "Values humor and lighthearted fun",
    Crime: "Fascinated by the criminal underworld",
    Documentary: "Seeks real-world stories and knowledge",
    Drama: "Appreciates emotional depth and character",
    Family: "Enjoys wholesome, all-ages content",
    Fantasy: "Loves magical worlds and imagination",
    History: "Drawn to stories of the past",
    Horror: "Enjoys suspense and being scared",
    Music: "Appreciates musical storytelling",
    Mystery: "Loves puzzles and whodunits",
    Romance: "Drawn to love stories and relationships",
    "Science Fiction": "Fascinated by futuristic concepts",
    Thriller: "Thrives on tension and suspense",
    War: "Drawn to conflict and heroism",
    Western: "Appreciates frontier stories",
  };
  traits.push(genreTraitMap[primary] || `Enjoys ${primary} films`);

  // Personality component from disposition
  const personalityMap: Record<string, string> = {
    lenient_wide: "Enthusiast",
    lenient_narrow: "Fan",
    balanced_wide: "Explorer",
    balanced_narrow: "Traditionalist",
    harsh_wide: "Critic",
    harsh_narrow: "Purist",
    insufficient: "Newcomer",
  };
  const personality = personalityMap[disposition] || "Viewer";

  // Genre component — use primary genre, with some creative mapping
  const genreNameMap: Record<string, string> = {
    Action: "Action",
    Adventure: "Adventure",
    Animation: "Animation",
    Comedy: "Comedy",
    Crime: "Crime",
    Documentary: "Documentary",
    Drama: "Drama",
    Family: "Family",
    Fantasy: "Fantasy",
    History: "History",
    Horror: "Horror",
    Music: "Music",
    Mystery: "Mystery",
    Romance: "Romance",
    "Science Fiction": "Sci-Fi",
    Thriller: "Thriller",
    War: "War",
    Western: "Western",
  };
  const genreLabel = genreNameMap[primary] || primary;

  const name = `The ${genreLabel} ${personality}`;

  // Description combines genre preference with viewing style
  const styleDescriptions: Record<string, string> = {
    lenient_wide: "with an open mind and varied tastes",
    lenient_narrow: "with consistent enthusiasm",
    balanced_wide: "with a discerning but fair eye",
    balanced_narrow: "with steady, reliable taste",
    harsh_wide: "with passionate, exacting standards",
    harsh_narrow: "with unwavering critical standards",
    insufficient: "still discovering their preferences",
  };
  const style = styleDescriptions[disposition] || "with a unique perspective";

  const description = secondary
    ? `Gravitates toward ${primary.toLowerCase()} and ${secondary.toLowerCase()} films ${style}`
    : `Gravitates toward ${primary.toLowerCase()} films ${style}`;

  return { name, description, traits };
}

/**
 * Run viewer archetype clustering on ML user vectors and save results.
 * Called during training while ML user vectors are still in memory.
 */
async function clusterAndSaveArchetypes(
  userVectors: Map<string, number[]>,
  householdUserVectors: Map<string, number[]>,
  mlRatings: Rating[],
  userFeatureCache: Map<string, UserFeatures>,
  k: number = 8
): Promise<void> {
  // Extract ML user vectors
  const mlVectors = new Map<string, number[]>();
  for (const [userId, vec] of userVectors) {
    if (userId.startsWith("ml_")) {
      mlVectors.set(userId, vec);
    }
  }

  if (mlVectors.size < k * 50) {
    console.log(`[MF Train] Not enough ML users for clustering (${mlVectors.size}), skipping`);
    return;
  }

  console.log(`[MF Train] Clustering ${mlVectors.size} ML users into ${k} archetypes...`);
  const clusters = kMeansClustering(mlVectors, k);
  console.log(`[MF Train] Found ${clusters.length} valid clusters`);

  if (clusters.length === 0) return;

  // Load genre names for analysis
  const genres = await prisma.genre.findMany({ select: { id: true, name: true } });
  const genreIdToName = new Map(genres.map((g) => [g.id, g.name]));

  // Analyze and save each cluster
  const savedNames = new Set<string>();
  const archetypeIds: { id: string; centroid: number[] }[] = [];

  for (const cluster of clusters) {
    const analysis = analyzeCluster(cluster, mlRatings, userFeatureCache, genreIdToName);

    // Deduplicate names
    let finalName = analysis.name;
    let suffix = 2;
    while (savedNames.has(finalName)) {
      finalName = `${analysis.name} ${suffix}`;
      suffix++;
    }
    savedNames.add(finalName);

    const archetype = await prisma.viewerArchetype.upsert({
      where: { name: finalName },
      create: {
        name: finalName,
        description: analysis.description,
        centroid: JSON.stringify(cluster.centroid),
        clusterSize: cluster.memberIds.length,
        topGenres: JSON.stringify(analysis.topGenres),
        disposition: analysis.disposition,
        traits: JSON.stringify(analysis.traits),
      },
      update: {
        description: analysis.description,
        centroid: JSON.stringify(cluster.centroid),
        clusterSize: cluster.memberIds.length,
        topGenres: JSON.stringify(analysis.topGenres),
        disposition: analysis.disposition,
        traits: JSON.stringify(analysis.traits),
      },
    });

    archetypeIds.push({ id: archetype.id, centroid: cluster.centroid });
  }

  // Delete stale archetypes not in current set
  const currentIds = archetypeIds.map((a) => a.id);
  await prisma.viewerArchetype.deleteMany({
    where: { id: { notIn: currentIds } },
  });

  // Match household users to nearest archetype
  let matched = 0;
  for (const [userId, userVec] of householdUserVectors) {
    let minDist = Infinity;
    let bestId: string | null = null;
    for (const arch of archetypeIds) {
      const dist = euclideanDistance(userVec, arch.centroid);
      if (dist < minDist) {
        minDist = dist;
        bestId = arch.id;
      }
    }
    if (bestId) {
      await prisma.userFeatureCache.updateMany({
        where: { userId },
        data: { archetypeId: bestId },
      });
      matched++;
    }
  }

  console.log(
    `[MF Train] Saved ${archetypeIds.length} archetypes, matched ${matched} household users`
  );
}
