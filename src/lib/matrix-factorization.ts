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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getTF(): Promise<{ tf: any; backend: "gpu" | "cpu" } | null> {
  if (_tfBackend === "none") return null;
  if (_tf) return { tf: _tf, backend: _tfBackend as "gpu" | "cpu" };

  // Use string indirection to prevent TypeScript from resolving the module at compile time
  const gpuPkg = "@tensorflow/tfjs-node-gpu";
  const cpuPkg = "@tensorflow/tfjs-node";
  try {
    _tf = await import(/* webpackIgnore: true */ gpuPkg);
    _tfBackend = "gpu";
    console.log("[MF] TensorFlow.js GPU backend loaded");
    return { tf: _tf, backend: "gpu" };
  } catch {
    try {
      _tf = await import(/* webpackIgnore: true */ cpuPkg);
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
const ML_RATING_WEIGHT = 0.05; // Relative weight vs household ratings (1.0). Lower reduces ML-domain dominance.
const ML_SAMPLE_PER_EPOCH = 1_000_000; // Cap ML examples per epoch to reduce ML-domain overfitting + speed training.
const ML_VALIDATION_SPLIT = 0.01; // Small deterministic holdout for ML-domain drift monitoring
const ML_VALIDATION_MAX = 50000; // Cap ML validation evaluation set for performance

function fnv1a32(input: string): number {
  // Deterministic non-crypto hash for stable splits.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h >>> 0;
}

function isInValidationSplit(userId: string, movieId: string, splitFraction: number): boolean {
  const pct = Math.max(1, Math.min(99, Math.floor(splitFraction * 100)));
  return fnv1a32(`${userId}:${movieId}`) % 100 < pct;
}

function mulberry32(seed: number): () => number {
  // Small deterministic PRNG for reproducible sampling/shuffles between retrains.
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function reservoirSample<T>(arr: T[], n: number, rand: () => number): T[] {
  if (n <= 0) return [];
  if (arr.length <= n) return [...arr];
  const out = arr.slice(0, n);
  for (let i = n; i < arr.length; i++) {
    const j = Math.floor(rand() * (i + 1));
    if (j < n) out[j] = arr[i];
  }
  return out;
}

function shuffleInPlace<T>(arr: T[], rand: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

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

function denormalizeRating(normalized: number, userMean: number, userStdDev: number): number {
  if (userStdDev < 0.1) return normalized;
  return userMean + (normalized - 3) * userStdDev;
}

function dcgAtK(relevances: number[], k: number): number {
  let sum = 0;
  for (let i = 0; i < Math.min(k, relevances.length); i++) {
    const rel = relevances[i];
    // Standard graded DCG.
    sum += (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }
  return sum;
}

function ndcgAtK(relevancesByRank: number[], k: number): number {
  const dcg = dcgAtK(relevancesByRank, k);
  if (dcg <= 0) return 0;
  const ideal = [...relevancesByRank].sort((a, b) => b - a);
  const idcg = dcgAtK(ideal, k);
  return idcg > 0 ? dcg / idcg : 0;
}

function mapAtK(binaryRelevancesByRank: boolean[], k: number): number {
  let hits = 0;
  let sumPrec = 0;
  for (let i = 0; i < Math.min(k, binaryRelevancesByRank.length); i++) {
    if (binaryRelevancesByRank[i]) {
      hits++;
      sumPrec += hits / (i + 1);
    }
  }
  return hits > 0 ? sumPrec / hits : 0;
}

function aucFromScores(positiveScores: number[], negativeScores: number[]): number {
  if (positiveScores.length === 0 || negativeScores.length === 0) return 0;
  let wins = 0;
  let ties = 0;
  for (const p of positiveScores) {
    for (const n of negativeScores) {
      if (p > n) wins++;
      else if (p === n) ties++;
    }
  }
  const total = positiveScores.length * negativeScores.length;
  return total > 0 ? (wins + 0.5 * ties) / total : 0;
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

function predictRatingTypedVectors(
  userVecs: Float32Array,
  userIndex: number,
  movieVecs: Float32Array,
  movieIndex: number,
  latentDimensions: number,
  userBias: number,
  movieBias: number,
  globalMean: number,
  movieFeatures: MovieFeatures,
  userFeatures: UserFeatures,
  householdFeatures: HouseholdFeatures,
  featureEmbeddings: Map<string, { vector: number[]; bias: number }>,
  featureDimensions: number
): number {
  const uOff = userIndex * latentDimensions;
  const mOff = movieIndex * latentDimensions;
  let dot = 0;
  for (let d = 0; d < latentDimensions; d++) {
    dot += userVecs[uOff + d] * movieVecs[mOff + d];
  }

  const dummyRating: Rating = {
    userId: "",
    movieId: "",
    rating: 0,
    weight: 1,
    movieFeatures,
    userFeatures,
    householdFeatures,
  };

  const featureContribution = computeFeatureContribution(dummyRating, featureEmbeddings, featureDimensions);
  const prediction = globalMean + userBias + movieBias + dot + featureContribution;
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
	    // Back-compat: regularization used to mean L2 reg. In GPU training this is treated as AdamW weight decay.
	    // Prefer passing weightDecay/featureRegularization explicitly going forward.
	    regularization?: number;
	    weightDecay?: number;
	    featureRegularization?: number;
	    // MovieLens joint-training controls (default caps avoid ML-domain dominating household validation)
	    mlRatingWeight?: number; // scales ML example loss contributions (household is 1.0)
	    mlSamplePerEpoch?: number; // max number of ML examples included per epoch (Infinity = all mapped ML)
	    // Epoch-by-epoch ranking eval on household validation set (approximate; sampled)
	    epochEval?: {
	      enabled?: boolean;
	      everyEpochs?: number; // 1 = every epoch
	      sampleUsers?: number; // number of validation users to evaluate
	      k?: number; // ranking cutoff
	      positiveThreshold?: number; // raw-star threshold to treat as "relevant" for MAP/Hit/AUC
	      negativesPerPositive?: number;
	      minNegatives?: number;
	      maxNegatives?: number;
	    };
	    latentDimensions?: number;
	    featureDimensions?: number;
	    // Viewer archetype clustering (ML user vectors) configuration
	    archetypeClusters?: number; // default 8
      archetypeDistance?: "euclidean" | "cosine"; // default cosine
	    earlyStopping?: {
	      enabled?: boolean;
	      patience?: number;
      minDelta?: number;
      // Which validation signal to optimize checkpoints/early-stop against.
      // - "rmse": minimize household validation RMSE (classic CF objective)
      // - "combined": maximize a blend of household valRMSE + ranking metrics (NDCG/MAP/Hit/AUC)
      metric?: "rmse" | "combined";
      combinedWeights?: {
        rmse?: number; // weight for RMSE-derived score (0..1, larger = more RMSE-driven)
        ndcg?: number;
        map?: number;
        hit?: number;
        auc?: number;
      };
    };
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
	  const legacyRegularization = options.regularization ?? DEFAULT_REGULARIZATION;
	  const weightDecay = options.weightDecay ?? legacyRegularization;
	  const featureRegularization = options.featureRegularization ?? legacyRegularization;
  const mlRatingWeight = options.mlRatingWeight ?? ML_RATING_WEIGHT;
  const mlSamplePerEpoch = options.mlSamplePerEpoch ?? ML_SAMPLE_PER_EPOCH;
  const latentDimensions = options.latentDimensions ?? DEFAULT_LATENT_DIMENSIONS;
  const featureDimensions = options.featureDimensions ?? DEFAULT_FEATURE_DIMENSIONS;
  const archetypeClusters = Math.max(2, Math.floor(options.archetypeClusters ?? 8));
  const archetypeDistance: "euclidean" | "cosine" = options.archetypeDistance ?? "cosine";

  const earlyStoppingEnabled = options.earlyStopping?.enabled === true;
  const earlyStoppingPatience = Math.max(1, Math.floor(options.earlyStopping?.patience ?? 3));
  const earlyStoppingMinDelta = Math.max(0, options.earlyStopping?.minDelta ?? 0.001);

  const epochEvalEnabled = options.epochEval?.enabled ?? true;
  const epochEvalEvery = Math.max(1, Math.floor(options.epochEval?.everyEpochs ?? 1));
  const epochEvalSampleUsers = Math.max(10, Math.floor(options.epochEval?.sampleUsers ?? 200));
  const epochEvalK = Math.max(1, Math.floor(options.epochEval?.k ?? 10));
  const epochEvalPositiveThreshold = Math.max(1, Math.min(5, options.epochEval?.positiveThreshold ?? 4));
  const epochEvalNegPerPos = Math.max(1, Math.floor(options.epochEval?.negativesPerPositive ?? 20));
  const epochEvalMinNeg = Math.max(0, Math.floor(options.epochEval?.minNegatives ?? 50));
  const epochEvalMaxNeg = Math.max(epochEvalMinNeg, Math.floor(options.epochEval?.maxNegatives ?? 200));

  const earlyStoppingMetric: "rmse" | "combined" =
    options.earlyStopping?.metric ??
    // If we have ranking metrics enabled, default early-stopping to combined, otherwise RMSE.
    (epochEvalEnabled ? "combined" : "rmse");

  const combinedWeights = {
    rmse: options.earlyStopping?.combinedWeights?.rmse ?? 0.45,
    ndcg: options.earlyStopping?.combinedWeights?.ndcg ?? 0.20,
    map: options.earlyStopping?.combinedWeights?.map ?? 0.20,
    hit: options.earlyStopping?.combinedWeights?.hit ?? 0.05,
    auc: options.earlyStopping?.combinedWeights?.auc ?? 0.10,
  };

  function clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
  }

  function combinedEarlyStopScore(input: {
    validationRmse: number;
    valNdcg: number;
    valMap: number;
    valHit: number;
    valAuc: number;
  }): number {
    // Ranking metrics are already 0..1. RMSE is unbounded and depends on scale,
    // so convert to a bounded score roughly aligned with typical ranges (~0.7..1.5).
    // 0.0 -> 1.0, 2.0 -> 0.0 (clamped).
    const rmseScore = clamp01(1 - input.validationRmse / 2);
    const sumWeights =
      combinedWeights.rmse +
      combinedWeights.ndcg +
      combinedWeights.map +
      combinedWeights.hit +
      combinedWeights.auc;
    if (sumWeights <= 0) return rmseScore;

    return (
      rmseScore * combinedWeights.rmse +
      input.valNdcg * combinedWeights.ndcg +
      input.valMap * combinedWeights.map +
      input.valHit * combinedWeights.hit +
      input.valAuc * combinedWeights.auc
    ) / sumWeights;
  }

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

    // Per-user rated movies (used for negative sampling in ranking-style validation evals)
    const ratedMoviesByUser = new Map<string, Set<string>>();
    for (const r of rawRatings) {
      if (!ratedMoviesByUser.has(r.userId)) ratedMoviesByUser.set(r.userId, new Set());
      ratedMoviesByUser.get(r.userId)!.add(r.movieId);
    }

    // Transform raw ratings to enriched format
    const movieFeaturesMap = new Map<string, MovieFeatures>(); // movieId -> features (household + ML-only)
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
      movieFeaturesMap.set(r.movieId, movieFeatures);

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
    const mlRatings: Rating[] = [];

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
      // Deterministic (no ORDER BY random()) so results are stable between retrains.
      // Note: this still needs to scan the MLRating index, but avoids the extreme cost of random ordering.
      const allMLUserIds: { mlUserId: string }[] = await prisma.$queryRaw`
        SELECT DISTINCT "mlUserId" FROM "MLRating" ORDER BY "mlUserId" LIMIT ${ML_SAMPLE_USERS}
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
	          weight: mlRatingWeight,
	          movieFeatures: mf,
	          userFeatures: uf,
	          householdFeatures: emptyHouseholdFeatures,
	        });
	      }

      // Add ML user features to cache (for vector initialization)
      for (const [mlUserId, features] of mlUserFeatureCache) {
        userFeatureCache.set(mlUserId, features);
      }

	      console.log(`[MF Train] Built ${mlRatings.length} ML training examples (weight: ${mlRatingWeight})`);
	    }

    // Deterministic ML split: train vs validation (for drift monitoring)
    const mlTrainingRatings: Rating[] = [];
    const mlValidationRatings: Rating[] = [];
    for (const r of mlRatings) {
      if (isInValidationSplit(r.userId, r.movieId, ML_VALIDATION_SPLIT)) mlValidationRatings.push(r);
      else mlTrainingRatings.push(r);
    }

    // Combine household + ML ratings (for feature universe construction etc.)
    const allRatings = [...ratings, ...mlRatings];

    // Calculate global mean (of household normalized ratings only — ML has different scale)
    const globalMean = ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length;

    // Split HOUSEHOLD ratings into training and validation (validate on household only).
    // Deterministic split so metrics are comparable between retrains and early stopping is stable.
    const validationSet = ratings.filter((r) => isInValidationSplit(r.userId, r.movieId, VALIDATION_SPLIT));
    const householdTrainingSet = ratings.filter((r) => !isInValidationSplit(r.userId, r.movieId, VALIDATION_SPLIT));
    console.log(
      `[MF Train] Household split: train=${householdTrainingSet.length} val=${validationSet.length} (fraction=${VALIDATION_SPLIT})`
    );

    const validationByUser = new Map<string, Rating[]>();
    for (const r of validationSet) {
      if (!validationByUser.has(r.userId)) validationByUser.set(r.userId, []);
      validationByUser.get(r.userId)!.push(r);
    }
    const validationUserSample = [...validationByUser.keys()]
      .sort((a, b) => fnv1a32(a) - fnv1a32(b))
      .slice(0, epochEvalSampleUsers);

    // Combine household training + ML ratings for the full training set
    const trainingSet = [...householdTrainingSet, ...mlTrainingRatings];

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
    const movieIdUniverse = [...movieIds];

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
    const getHouseholdConsensusScore = (userId: string, movieId: string): number => {
      const householdMembers = householdMemberMap.get(userId);
      if (!householdMembers || householdMembers.size === 0) return 0;
      const movieRatings = movieRatingLookup.get(movieId);
      if (!movieRatings) return 0;
      let sum = 0;
      let count = 0;
      for (const memberId of householdMembers) {
        const r = movieRatings.get(memberId);
        if (r !== undefined) {
          sum += r;
          count++;
        }
      }
      return count > 0 ? sum / count : 0;
    };

    const tfResult = await getTF();
    let rmse = 0;
    let validationRmse = 0;
    let mlValidationRmse = 0;

    // Stable ML validation sample for logging (kept small for perf)
    const mlValidationSample =
      mlValidationRatings.length > ML_VALIDATION_MAX
        ? [...mlValidationRatings]
            .sort((a, b) => fnv1a32(`${a.userId}:${a.movieId}`) - fnv1a32(`${b.userId}:${b.movieId}`))
            .slice(0, ML_VALIDATION_MAX)
        : mlValidationRatings;

    const mlValidationByUser = new Map<string, Rating[]>();
    for (const r of mlValidationSample) {
      if (!mlValidationByUser.has(r.userId)) mlValidationByUser.set(r.userId, []);
      mlValidationByUser.get(r.userId)!.push(r);
    }
    const mlValidationUserSample = [...mlValidationByUser.keys()]
      .sort((a, b) => fnv1a32(a) - fnv1a32(b))
      .slice(0, epochEvalSampleUsers);

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

      // AdamW optimizer state for GPU parameters
      const ADAM_BETA1 = 0.9;
      const ADAM_BETA2 = 0.999;
      const ADAM_EPSILON = 1e-8;
      const adamLR = learningRate * 0.2; // Adam needs lower LR than SGD (0.005 * 0.2 = 0.001)
      const weightDecayLocal = weightDecay; // AdamW decoupled weight decay (applied to vectors, not biases)
      let adamStep = 0;

      // First moment (mean) and second moment (variance) estimates
      const uVecM = tf.variable(tf.zeros([numUsers, latentDimensions]));
      const uVecV = tf.variable(tf.zeros([numUsers, latentDimensions]));
      const mVecM = tf.variable(tf.zeros([numMovies, latentDimensions]));
      const mVecV = tf.variable(tf.zeros([numMovies, latentDimensions]));
      const uBiasM = tf.variable(tf.zeros([numUsers]));
      const uBiasV = tf.variable(tf.zeros([numUsers]));
      const mBiasM = tf.variable(tf.zeros([numMovies]));
      const mBiasV = tf.variable(tf.zeros([numMovies]));

      // Feature embedding learning rate (simple SGD with lower rate for CPU-side features)
      let featureLR = learningRate * 0.2;

      // Early stopping (best checkpoint in memory; restored before saving)
      let bestVal = earlyStoppingMetric === "combined" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
      let bestEpoch = -1;
      let epochsWithoutImprove = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let bestUTensor: any | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let bestMTensor: any | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let bestUBiasTensor: any | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let bestMBiasTensor: any | null = null;
      let bestFeatureEmbeddings: Map<string, { vector: number[]; bias: number }> | null = null;

      for (let epoch = 0; epoch < epochs; epoch++) {
	        let epochTraining: Rating[];
	        if (mlTrainingRatings.length > mlSamplePerEpoch) {
	          const rand = mulberry32(fnv1a32(`ml-sample:${epoch}`));
	          const sampledML = reservoirSample(mlTrainingRatings, mlSamplePerEpoch, rand);
	          epochTraining = [...householdTrainingSet, ...sampledML];
	        } else {
	          epochTraining = trainingSet;
	        }

	        // Shuffle (seeded for reproducibility between retrains)
	        shuffleInPlace(epochTraining, mulberry32(fnv1a32(`epoch-shuffle:${epoch}`)));

        let totalSquaredError = 0;
        let householdCount = 0;
        const totalBatches = Math.ceil(epochTraining.length / BATCH_SIZE);

        for (let bStart = 0; bStart < epochTraining.length; bStart += BATCH_SIZE) {
          const batchNum = Math.floor(bStart / BATCH_SIZE) + 1;
          if (batchNum === 1 || batchNum % 50 === 0) {
            console.log(`[MF Train] Epoch ${epoch + 1}/${epochs} batch ${batchNum}/${totalBatches}`);
          }
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

          // GPU: batch MF prediction, error computation, and AdamW gradient updates
          adamStep++;
          const biasCorrection1 = 1 - Math.pow(ADAM_BETA1, adamStep);
          const biasCorrection2 = 1 - Math.pow(ADAM_BETA2, adamStep);
          const correctedLR = adamLR * Math.sqrt(biasCorrection2) / biasCorrection1;

          // Step 1: Compute averaged gradients and errors (tidy cleans intermediates)
          const { errors: rawErrors, uGrad, mGrad, uBGrad, mBGrad } = tf.tidy(() => {
            const userIdx = tf.tensor1d(userIdxArr, "int32");
            const movieIdx = tf.tensor1d(movieIdxArr, "int32");
            const targets = tf.tensor1d(targetArr);
            const weights = tf.tensor1d(weightArr);
            const featC = tf.tensor1d(featContribs);

            // Gather vectors for this batch
            const bUserVecs = tf.gather(uTensor, userIdx);
            const bMovieVecs = tf.gather(mTensor, movieIdx);
            const bUserBias = tf.gather(uBiasTensor, userIdx);
            const bMovieBias = tf.gather(mBiasTensor, movieIdx);

            // Predict
            const dots = tf.sum(tf.mul(bUserVecs, bMovieVecs), 1);
            const preds = dots.add(bUserBias).add(bMovieBias).add(globalMean).add(featC);

            const errors = targets.sub(preds);
            const wErrors = errors.mul(weights);

            // Gradients (no L2 here): AdamW decoupled weight decay applied in the update step.
            const wErrorsExp = tf.expandDims(wErrors, 1);
            const userGrads = tf.mul(wErrorsExp, bMovieVecs);
            const movieGrads = tf.mul(wErrorsExp, bUserVecs);
            const userBiasGrads = wErrors;
            const movieBiasGrads = wErrors;

            // Average gradients per entity
            const onesVec = tf.ones([B]);
            const userCounts = tf.unsortedSegmentSum(onesVec, userIdx, numUsers);
            const movieCounts = tf.unsortedSegmentSum(onesVec, movieIdx, numMovies);
            const userCountsExp = tf.maximum(userCounts.expandDims(1), 1);
            const movieCountsExp = tf.maximum(movieCounts.expandDims(1), 1);

            const uGrad = tf.div(tf.unsortedSegmentSum(userGrads, userIdx, numUsers), userCountsExp);
            const mGrad = tf.div(tf.unsortedSegmentSum(movieGrads, movieIdx, numMovies), movieCountsExp);
            const uBGrad = tf.div(tf.unsortedSegmentSum(userBiasGrads, userIdx, numUsers), tf.maximum(userCounts, 1));
            const mBGrad = tf.div(tf.unsortedSegmentSum(movieBiasGrads, movieIdx, numMovies), tf.maximum(movieCounts, 1));

            // Keep these alive (not disposed by tidy) for Adam update
            return { errors: tf.keep(errors), uGrad: tf.keep(uGrad), mGrad: tf.keep(mGrad), uBGrad: tf.keep(uBGrad), mBGrad: tf.keep(mBGrad) };
          });

          // Step 2: AdamW update (decoupled weight decay on vectors only; no decay on biases)
          tf.tidy(() => {
            const beta1 = ADAM_BETA1;
            const beta2 = ADAM_BETA2;
            const eps = ADAM_EPSILON;
            const lr = correctedLR;

            // Update user vectors
            uVecM.assign(uVecM.mul(beta1).add(uGrad.mul(1 - beta1)));
            uVecV.assign(uVecV.mul(beta2).add(uGrad.square().mul(1 - beta2)));
            uTensor.assign(
              uTensor
                .mul(1 - lr * weightDecayLocal)
                .add(uVecM.div(uVecV.sqrt().add(eps)).mul(lr))
            );

            // Update movie vectors
            mVecM.assign(mVecM.mul(beta1).add(mGrad.mul(1 - beta1)));
            mVecV.assign(mVecV.mul(beta2).add(mGrad.square().mul(1 - beta2)));
            mTensor.assign(
              mTensor
                .mul(1 - lr * weightDecayLocal)
                .add(mVecM.div(mVecV.sqrt().add(eps)).mul(lr))
            );

            // Update user biases
            uBiasM.assign(uBiasM.mul(beta1).add(uBGrad.mul(1 - beta1)));
            uBiasV.assign(uBiasV.mul(beta2).add(uBGrad.square().mul(1 - beta2)));
            uBiasTensor.assign(uBiasTensor.add(uBiasM.div(uBiasV.sqrt().add(eps)).mul(lr)));

            // Update movie biases
            mBiasM.assign(mBiasM.mul(beta1).add(mBGrad.mul(1 - beta1)));
            mBiasV.assign(mBiasV.mul(beta2).add(mBGrad.square().mul(1 - beta2)));
            mBiasTensor.assign(mBiasTensor.add(mBiasM.div(mBiasV.sqrt().add(eps)).mul(lr)));
          });

          // Dispose kept gradient tensors
          uGrad.dispose();
          mGrad.dispose();
          uBGrad.dispose();
          mBGrad.dispose();

          // Read errors back to CPU
          const errorArr = rawErrors.dataSync() as Float32Array;
          rawErrors.dispose();

          // CPU: update feature embeddings using errors
          for (let i = 0; i < B; i++) {
            const wError = errorArr[i] * batch[i].weight;
            updateFeatureEmbeddings(batch[i], wError, featureEmbeddings, featureLR, featureRegularization, featureDimensions);

            if (batch[i].weight === 1.0) {
              totalSquaredError += errorArr[i] * errorArr[i];
              householdCount++;
            }
          }
        }

        rmse = householdCount > 0 ? Math.sqrt(totalSquaredError / householdCount) : 0;

        // Compute validation RMSE every epoch (sync vectors from GPU first)
        const isLogEpoch = true;
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
            const predicted = predictRatingTypedVectors(
              curUVecs,
              uIdx,
              curMVecs,
              mIdx,
              latentDimensions,
              curUBias[uIdx],
              curMBias[mIdx],
              globalMean,
              rating.movieFeatures,
              rating.userFeatures,
              rating.householdFeatures,
              featureEmbeddings,
              featureDimensions
            );
            validationSquaredError += Math.pow(rating.rating - predicted, 2);
          }
          validationRmse = Math.sqrt(validationSquaredError / validationSet.length);

          // ML validation RMSE (drift monitoring; sampled for perf)
          if (mlValidationSample.length > 0) {
            let mlValSquared = 0;
            let mlValCount = 0;
            for (const rating of mlValidationSample) {
              const uIdx = userIdxMap.get(rating.userId);
              const mIdx = movieIdxMap.get(rating.movieId);
              if (uIdx === undefined || mIdx === undefined) continue;
              const predicted = predictRatingTypedVectors(
                curUVecs,
                uIdx,
                curMVecs,
                mIdx,
                latentDimensions,
                curUBias[uIdx],
                curMBias[mIdx],
                globalMean,
                rating.movieFeatures,
                rating.userFeatures,
                rating.householdFeatures,
                featureEmbeddings,
                featureDimensions
              );
              mlValSquared += Math.pow(rating.rating - predicted, 2);
              mlValCount++;
            }
            mlValidationRmse = mlValCount > 0 ? Math.sqrt(mlValSquared / mlValCount) : 0;
          } else {
            mlValidationRmse = 0;
          }

          // Approximate ranking metrics on household validation (sampled users; small candidate sets).
          let valNdcg = 0;
          let valMap = 0;
          let valHit = 0;
          let valAuc = 0;
          let evalUsers = 0;
          if (
            epochEvalEnabled &&
            (epoch + 1) % epochEvalEvery === 0 &&
            validationUserSample.length > 0 &&
            movieIdUniverse.length > 0
          ) {
            for (const userId of validationUserSample) {
              const uIdx = userIdxMap.get(userId);
              if (uIdx === undefined) continue;
              const uf = userFeatureCache.get(userId);
              if (!uf) continue;

              const userVal = validationByUser.get(userId) ?? [];
              const positiveRatings = userVal
                .map((r) => ({
                  movieId: r.movieId,
                  rel: denormalizeRating(r.rating, r.userFeatures.ratingMean, r.userFeatures.ratingStdDev),
                  consensusScore: r.householdFeatures.consensusScore,
                }))
                .filter((x) => x.rel >= epochEvalPositiveThreshold)
                .sort((a, b) => b.rel - a.rel)
                .slice(0, 5);

              if (positiveRatings.length === 0) continue;

              const ratedSet = ratedMoviesByUser.get(userId) ?? new Set<string>();
              const posMovieIds = new Set(positiveRatings.map((p) => p.movieId));
              const targetNeg = Math.min(
                epochEvalMaxNeg,
                Math.max(epochEvalMinNeg, positiveRatings.length * epochEvalNegPerPos)
              );

              const rand = mulberry32(fnv1a32(`epoch-eval-neg:${epoch}:${userId}`));
              const negatives: string[] = [];
              const seen = new Set<string>(posMovieIds);
              let attempts = 0;
              while (negatives.length < targetNeg && attempts < targetNeg * 50) {
                attempts++;
                const idx = Math.floor(rand() * movieIdUniverse.length);
                const mid = movieIdUniverse[idx];
                if (!mid) continue;
                if (seen.has(mid)) continue;
                if (ratedSet.has(mid)) continue;
                if (!movieFeaturesMap.has(mid)) continue;
                if (movieIdxMap.get(mid) === undefined) continue;
                seen.add(mid);
                negatives.push(mid);
              }

              const candidates: { score: number; rel: number; isPos: boolean }[] = [];
              const posScores: number[] = [];
              const negScores: number[] = [];

              for (const p of positiveRatings) {
                const mIdx = movieIdxMap.get(p.movieId);
                if (mIdx === undefined) continue;
                const mf = movieFeaturesMap.get(p.movieId);
                if (!mf) continue;
                const hh: HouseholdFeatures = { otherUserRatings: new Map(), consensusScore: p.consensusScore };
                const s = predictRatingTypedVectors(
                  curUVecs,
                  uIdx,
                  curMVecs,
                  mIdx,
                  latentDimensions,
                  curUBias[uIdx],
                  curMBias[mIdx],
                  globalMean,
                  mf,
                  uf,
                  hh,
                  featureEmbeddings,
                  featureDimensions
                );
                candidates.push({ score: s, rel: p.rel, isPos: true });
                posScores.push(s);
              }

              for (const mid of negatives) {
                const mIdx = movieIdxMap.get(mid);
                if (mIdx === undefined) continue;
                const mf = movieFeaturesMap.get(mid);
                if (!mf) continue;
                const consensusScore = getHouseholdConsensusScore(userId, mid);
                const hh: HouseholdFeatures = { otherUserRatings: new Map(), consensusScore };
                const s = predictRatingTypedVectors(
                  curUVecs,
                  uIdx,
                  curMVecs,
                  mIdx,
                  latentDimensions,
                  curUBias[uIdx],
                  curMBias[mIdx],
                  globalMean,
                  mf,
                  uf,
                  hh,
                  featureEmbeddings,
                  featureDimensions
                );
                candidates.push({ score: s, rel: 0, isPos: false });
                negScores.push(s);
              }

              if (candidates.length === 0 || posScores.length === 0 || negScores.length === 0) continue;

              candidates.sort((a, b) => b.score - a.score);
              const relByRank = candidates.map((c) => c.rel);
              const binByRank = candidates.map((c) => c.rel >= epochEvalPositiveThreshold);

              valNdcg += ndcgAtK(relByRank, epochEvalK);
              valMap += mapAtK(binByRank, epochEvalK);
              valHit += binByRank.slice(0, epochEvalK).some(Boolean) ? 1 : 0;
              valAuc += aucFromScores(posScores, negScores);
              evalUsers++;
            }

            if (evalUsers > 0) {
              valNdcg /= evalUsers;
              valMap /= evalUsers;
              valHit /= evalUsers;
              valAuc /= evalUsers;
            }
          }

          // Approximate ranking metrics on ML validation (sampled users; small candidate sets).
          // Note: we do NOT currently exclude ML training-rated movies from negative sampling (intentional "leaky-ish"
          // diagnostic, since we don't materialize per-ML-user rated sets for memory reasons).
          let mlValNdcg = 0;
          let mlValMap = 0;
          let mlValHit = 0;
          let mlValAuc = 0;
          let mlEvalUsers = 0;
          if (
            epochEvalEnabled &&
            (epoch + 1) % epochEvalEvery === 0 &&
            mlValidationUserSample.length > 0 &&
            movieIdUniverse.length > 0
          ) {
            for (const userId of mlValidationUserSample) {
              const uIdx = userIdxMap.get(userId);
              if (uIdx === undefined) continue;
              const uf = userFeatureCache.get(userId);
              if (!uf) continue;

              const userVal = mlValidationByUser.get(userId) ?? [];
              const positiveRatings = userVal
                .map((r) => ({
                  movieId: r.movieId,
                  rel: denormalizeRating(r.rating, r.userFeatures.ratingMean, r.userFeatures.ratingStdDev),
                }))
                .filter((x) => x.rel >= epochEvalPositiveThreshold)
                .sort((a, b) => b.rel - a.rel)
                .slice(0, 5);

              if (positiveRatings.length === 0) continue;

              const posMovieIds = new Set(positiveRatings.map((p) => p.movieId));
              const targetNeg = Math.min(
                epochEvalMaxNeg,
                Math.max(epochEvalMinNeg, positiveRatings.length * epochEvalNegPerPos)
              );

              const rand = mulberry32(fnv1a32(`epoch-eval-neg:${epoch}:${userId}`));
              const negatives: string[] = [];
              const seen = new Set<string>(posMovieIds);
              let attempts = 0;
              while (negatives.length < targetNeg && attempts < targetNeg * 50) {
                attempts++;
                const idx = Math.floor(rand() * movieIdUniverse.length);
                const mid = movieIdUniverse[idx];
                if (!mid) continue;
                if (seen.has(mid)) continue;
                if (!movieFeaturesMap.has(mid)) continue;
                if (movieIdxMap.get(mid) === undefined) continue;
                seen.add(mid);
                negatives.push(mid);
              }

              const candidates: { score: number; rel: number; isPos: boolean }[] = [];
              const posScores: number[] = [];
              const negScores: number[] = [];

              for (const p of positiveRatings) {
                const mIdx = movieIdxMap.get(p.movieId);
                if (mIdx === undefined) continue;
                const mf = movieFeaturesMap.get(p.movieId);
                if (!mf) continue;
                const hh: HouseholdFeatures = { otherUserRatings: new Map(), consensusScore: 0 };
                const s = predictRatingTypedVectors(
                  curUVecs,
                  uIdx,
                  curMVecs,
                  mIdx,
                  latentDimensions,
                  curUBias[uIdx],
                  curMBias[mIdx],
                  globalMean,
                  mf,
                  uf,
                  hh,
                  featureEmbeddings,
                  featureDimensions
                );
                candidates.push({ score: s, rel: p.rel, isPos: true });
                posScores.push(s);
              }

              for (const mid of negatives) {
                const mIdx = movieIdxMap.get(mid);
                if (mIdx === undefined) continue;
                const mf = movieFeaturesMap.get(mid);
                if (!mf) continue;
                const hh: HouseholdFeatures = { otherUserRatings: new Map(), consensusScore: 0 };
                const s = predictRatingTypedVectors(
                  curUVecs,
                  uIdx,
                  curMVecs,
                  mIdx,
                  latentDimensions,
                  curUBias[uIdx],
                  curMBias[mIdx],
                  globalMean,
                  mf,
                  uf,
                  hh,
                  featureEmbeddings,
                  featureDimensions
                );
                candidates.push({ score: s, rel: 0, isPos: false });
                negScores.push(s);
              }

              if (candidates.length === 0 || posScores.length === 0 || negScores.length === 0) continue;

              candidates.sort((a, b) => b.score - a.score);
              const relByRank = candidates.map((c) => c.rel);
              const binByRank = candidates.map((c) => c.rel >= epochEvalPositiveThreshold);

              mlValNdcg += ndcgAtK(relByRank, epochEvalK);
              mlValMap += mapAtK(binByRank, epochEvalK);
              mlValHit += binByRank.slice(0, epochEvalK).some(Boolean) ? 1 : 0;
              mlValAuc += aucFromScores(posScores, negScores);
              mlEvalUsers++;
            }

            if (mlEvalUsers > 0) {
              mlValNdcg /= mlEvalUsers;
              mlValMap /= mlEvalUsers;
              mlValHit /= mlEvalUsers;
              mlValAuc /= mlEvalUsers;
            }
          }

          const effectiveLR = adamLR * Math.sqrt(1 - Math.pow(ADAM_BETA2, adamStep)) / (1 - Math.pow(ADAM_BETA1, adamStep));
          console.log(
            `[MF Train] Epoch ${epoch + 1}/${epochs}: RMSE=${rmse.toFixed(4)} valRMSE=${validationRmse.toFixed(4)}` +
              (mlValidationSample.length > 0 ? ` mlValRMSE=${mlValidationRmse.toFixed(4)}` : ``) +
              (evalUsers > 0
                ? ` valNDCG@${epochEvalK}=${valNdcg.toFixed(4)} valMAP@${epochEvalK}=${valMap.toFixed(4)} valHit@${epochEvalK}=${valHit.toFixed(4)} valAUC=${valAuc.toFixed(4)}`
                : ``) +
              (mlEvalUsers > 0
                ? ` mlNDCG@${epochEvalK}=${mlValNdcg.toFixed(4)} mlMAP@${epochEvalK}=${mlValMap.toFixed(4)} mlHit@${epochEvalK}=${mlValHit.toFixed(4)} mlAUC=${mlValAuc.toFixed(4)}`
                : ``) +
              ` adamLR=${effectiveLR.toFixed(6)} wd=${weightDecayLocal.toFixed(4)} featLR=${featureLR.toFixed(6)} step=${adamStep} (${backend})`
          );

          // Early stopping uses household validation only (RMSE or a combined score that also includes ranking metrics).
          if (earlyStoppingEnabled) {
            const hasRanking = evalUsers > 0;
            const useCombined = earlyStoppingMetric === "combined" && hasRanking;
            const currentMetric = useCombined
              ? combinedEarlyStopScore({
                  validationRmse,
                  valNdcg,
                  valMap,
                  valHit,
                  valAuc,
                })
              : validationRmse;

            const improved =
              useCombined
                ? currentMetric > bestVal + earlyStoppingMinDelta
                : currentMetric + earlyStoppingMinDelta < bestVal;
            if (improved) {
              bestVal = currentMetric;
              bestEpoch = epoch;
              epochsWithoutImprove = 0;

              // Replace best checkpoint (dispose previous tensors to avoid GPU leak).
              if (bestUTensor) bestUTensor.dispose();
              if (bestMTensor) bestMTensor.dispose();
              if (bestUBiasTensor) bestUBiasTensor.dispose();
              if (bestMBiasTensor) bestMBiasTensor.dispose();

              bestUTensor = uTensor.clone();
              bestMTensor = mTensor.clone();
              bestUBiasTensor = uBiasTensor.clone();
              bestMBiasTensor = mBiasTensor.clone();

              // Deep copy feature embeddings (small enough to snapshot; avoids mutation after checkpoint).
              bestFeatureEmbeddings = new Map();
              for (const [k, v] of featureEmbeddings.entries()) {
                bestFeatureEmbeddings.set(k, { vector: [...v.vector], bias: v.bias });
              }

              console.log(
                useCombined
                  ? `[MF Train] EarlyStop checkpoint: best combined=${bestVal.toFixed(4)} at epoch ${bestEpoch + 1}`
                  : `[MF Train] EarlyStop checkpoint: best valRMSE=${bestVal.toFixed(4)} at epoch ${bestEpoch + 1}`
              );
            } else {
              epochsWithoutImprove++;
              if (epochsWithoutImprove >= earlyStoppingPatience) {
                console.log(
                  useCombined
                    ? `[MF Train] EarlyStop: no combined improvement for ${earlyStoppingPatience} epoch(s). Stopping at epoch ${epoch + 1}/${epochs}; best was epoch ${bestEpoch + 1} (combined=${bestVal.toFixed(4)}).`
                    : `[MF Train] EarlyStop: no valRMSE improvement for ${earlyStoppingPatience} epoch(s). Stopping at epoch ${epoch + 1}/${epochs}; best was epoch ${bestEpoch + 1} (valRMSE=${bestVal.toFixed(4)}).`
                );
                break;
              }
            }
          }
        }

        // Decay feature embedding LR (AdamW handles its own adaptive LR for GPU params)
        featureLR *= 0.98;
      }

      // If early stopping was enabled, restore best checkpointed weights before saving.
      if (earlyStoppingEnabled && bestUTensor && bestMTensor && bestUBiasTensor && bestMBiasTensor) {
        tf.tidy(() => {
          uTensor.assign(bestUTensor);
          mTensor.assign(bestMTensor);
          uBiasTensor.assign(bestUBiasTensor);
          mBiasTensor.assign(bestMBiasTensor);
        });
        if (bestFeatureEmbeddings) {
          featureEmbeddings.clear();
          for (const [k, v] of bestFeatureEmbeddings.entries()) {
            featureEmbeddings.set(k, { vector: [...v.vector], bias: v.bias });
          }
        }
        // Dispose checkpoint tensors after restore.
        bestUTensor.dispose();
        bestMTensor.dispose();
        bestUBiasTensor.dispose();
        bestMBiasTensor.dispose();
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
      // Cleanup AdamW moment tensors
      uVecM.dispose();
      uVecV.dispose();
      mVecM.dispose();
      mVecV.dispose();
      uBiasM.dispose();
      uBiasV.dispose();
      mBiasM.dispose();
      mBiasV.dispose();

      console.log(`[MF Train] GPU/BLAS training complete: ${epochs} epochs, RMSE=${rmse.toFixed(4)}`);
    } else {
      // ── Pure JavaScript fallback (no tf.js) ──
      console.log(`[MF Train] Using pure JS training loop`);

      // Early stopping (best checkpoint in memory; restored before saving)
      let bestVal = earlyStoppingMetric === "combined" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
      let bestEpoch = -1;
      let epochsWithoutImprove = 0;
      let bestUserVectors: Map<string, number[]> | null = null;
      let bestMovieVectors: Map<string, number[]> | null = null;
      let bestUserBiases: Map<string, number> | null = null;
      let bestMovieBiases: Map<string, number> | null = null;
      let bestFeatureEmbeddings: Map<string, { vector: number[]; bias: number }> | null = null;

      for (let epoch = 0; epoch < epochs; epoch++) {
        let epochTraining: Rating[];
        if (mlTrainingRatings.length > mlSamplePerEpoch) {
          const rand = mulberry32(fnv1a32(`ml-sample:${epoch}`));
          const sampledML = reservoirSample(mlTrainingRatings, mlSamplePerEpoch, rand);
          epochTraining = [...householdTrainingSet, ...sampledML];
        } else {
          epochTraining = trainingSet;
        }

        // Shuffle (seeded for reproducibility between retrains)
        shuffleInPlace(epochTraining, mulberry32(fnv1a32(`epoch-shuffle:${epoch}`)));

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

          userBiases.set(rating.userId, userBias + learningRate * (weightedError - featureRegularization * userBias));
          movieBiases.set(rating.movieId, movieBias + learningRate * (weightedError - featureRegularization * movieBias));

          for (let k = 0; k < latentDimensions; k++) {
            const userK = userVector[k];
            const movieK = movieVector[k];
            userVector[k] += learningRate * (weightedError * movieK - featureRegularization * userK);
            movieVector[k] += learningRate * (weightedError * userK - featureRegularization * movieK);
          }

          updateFeatureEmbeddings(rating, weightedError, featureEmbeddings, learningRate, featureRegularization, featureDimensions);
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

        // Approximate ranking metrics on household validation (sampled users; small candidate sets).
        let valNdcg = 0;
        let valMap = 0;
        let valHit = 0;
        let valAuc = 0;
        let evalUsers = 0;
        if (
          epochEvalEnabled &&
          (epoch + 1) % epochEvalEvery === 0 &&
          validationUserSample.length > 0 &&
          movieIdUniverse.length > 0
        ) {
          for (const userId of validationUserSample) {
            const userVector = userVectors.get(userId);
            if (!userVector) continue;
            const uf = userFeatureCache.get(userId);
            if (!uf) continue;

            const userVal = validationByUser.get(userId) ?? [];
            const positiveRatings = userVal
              .map((r) => ({
                movieId: r.movieId,
                rel: denormalizeRating(r.rating, r.userFeatures.ratingMean, r.userFeatures.ratingStdDev),
                consensusScore: r.householdFeatures.consensusScore,
              }))
              .filter((x) => x.rel >= epochEvalPositiveThreshold)
              .sort((a, b) => b.rel - a.rel)
              .slice(0, 5);
            if (positiveRatings.length === 0) continue;

            const ratedSet = ratedMoviesByUser.get(userId) ?? new Set<string>();
            const posMovieIds = new Set(positiveRatings.map((p) => p.movieId));
            const targetNeg = Math.min(
              epochEvalMaxNeg,
              Math.max(epochEvalMinNeg, positiveRatings.length * epochEvalNegPerPos)
            );

            const rand = mulberry32(fnv1a32(`epoch-eval-neg:${epoch}:${userId}`));
            const negatives: string[] = [];
            const seen = new Set<string>(posMovieIds);
            let attempts = 0;
            while (negatives.length < targetNeg && attempts < targetNeg * 50) {
              attempts++;
              const idx = Math.floor(rand() * movieIdUniverse.length);
              const mid = movieIdUniverse[idx];
              if (!mid) continue;
              if (seen.has(mid)) continue;
              if (ratedSet.has(mid)) continue;
              if (!movieFeaturesMap.has(mid)) continue;
              seen.add(mid);
              negatives.push(mid);
            }

            const candidates: { score: number; rel: number; isPos: boolean }[] = [];
            const posScores: number[] = [];
            const negScores: number[] = [];

            for (const p of positiveRatings) {
              const movieVector = movieVectors.get(p.movieId);
              if (!movieVector) continue;
              const mf = movieFeaturesMap.get(p.movieId);
              if (!mf) continue;
              const hh: HouseholdFeatures = { otherUserRatings: new Map(), consensusScore: p.consensusScore };
              const s = predictRating(
                userVector,
                movieVector,
                userBiases.get(userId) ?? 0,
                movieBiases.get(p.movieId) ?? 0,
                globalMean,
                mf,
                uf,
                hh,
                featureEmbeddings,
                featureDimensions
              );
              candidates.push({ score: s, rel: p.rel, isPos: true });
              posScores.push(s);
            }

            for (const mid of negatives) {
              const movieVector = movieVectors.get(mid);
              if (!movieVector) continue;
              const mf = movieFeaturesMap.get(mid);
              if (!mf) continue;
              const consensusScore = getHouseholdConsensusScore(userId, mid);
              const hh: HouseholdFeatures = { otherUserRatings: new Map(), consensusScore };
              const s = predictRating(
                userVector,
                movieVector,
                userBiases.get(userId) ?? 0,
                movieBiases.get(mid) ?? 0,
                globalMean,
                mf,
                uf,
                hh,
                featureEmbeddings,
                featureDimensions
              );
              candidates.push({ score: s, rel: 0, isPos: false });
              negScores.push(s);
            }

            if (candidates.length === 0 || posScores.length === 0 || negScores.length === 0) continue;

            candidates.sort((a, b) => b.score - a.score);
            const relByRank = candidates.map((c) => c.rel);
            const binByRank = candidates.map((c) => c.rel >= epochEvalPositiveThreshold);

            valNdcg += ndcgAtK(relByRank, epochEvalK);
            valMap += mapAtK(binByRank, epochEvalK);
            valHit += binByRank.slice(0, epochEvalK).some(Boolean) ? 1 : 0;
            valAuc += aucFromScores(posScores, negScores);
            evalUsers++;
          }

          if (evalUsers > 0) {
            valNdcg /= evalUsers;
            valMap /= evalUsers;
            valHit /= evalUsers;
            valAuc /= evalUsers;
          }
        }

        // Approximate ranking metrics on ML validation (sampled users; small candidate sets).
        let mlValNdcg = 0;
        let mlValMap = 0;
        let mlValHit = 0;
        let mlValAuc = 0;
        let mlEvalUsers = 0;
        if (
          epochEvalEnabled &&
          (epoch + 1) % epochEvalEvery === 0 &&
          mlValidationUserSample.length > 0 &&
          movieIdUniverse.length > 0
        ) {
          for (const userId of mlValidationUserSample) {
            const userVector = userVectors.get(userId);
            if (!userVector) continue;
            const uf = userFeatureCache.get(userId);
            if (!uf) continue;

            const userVal = mlValidationByUser.get(userId) ?? [];
            const positiveRatings = userVal
              .map((r) => ({
                movieId: r.movieId,
                rel: denormalizeRating(r.rating, r.userFeatures.ratingMean, r.userFeatures.ratingStdDev),
              }))
              .filter((x) => x.rel >= epochEvalPositiveThreshold)
              .sort((a, b) => b.rel - a.rel)
              .slice(0, 5);

            if (positiveRatings.length === 0) continue;

            const posMovieIds = new Set(positiveRatings.map((p) => p.movieId));
            const targetNeg = Math.min(
              epochEvalMaxNeg,
              Math.max(epochEvalMinNeg, positiveRatings.length * epochEvalNegPerPos)
            );

            const rand = mulberry32(fnv1a32(`epoch-eval-neg:${epoch}:${userId}`));
            const negatives: string[] = [];
            const seen = new Set<string>(posMovieIds);
            let attempts = 0;
            while (negatives.length < targetNeg && attempts < targetNeg * 50) {
              attempts++;
              const idx = Math.floor(rand() * movieIdUniverse.length);
              const mid = movieIdUniverse[idx];
              if (!mid) continue;
              if (seen.has(mid)) continue;
              if (!movieFeaturesMap.has(mid)) continue;
              seen.add(mid);
              negatives.push(mid);
            }

            const candidates: { score: number; rel: number; isPos: boolean }[] = [];
            const posScores: number[] = [];
            const negScores: number[] = [];

            for (const p of positiveRatings) {
              const movieVector = movieVectors.get(p.movieId);
              if (!movieVector) continue;
              const mf = movieFeaturesMap.get(p.movieId);
              if (!mf) continue;
              const hh: HouseholdFeatures = { otherUserRatings: new Map(), consensusScore: 0 };
              const s = predictRating(
                userVector,
                movieVector,
                userBiases.get(userId) ?? 0,
                movieBiases.get(p.movieId) ?? 0,
                globalMean,
                mf,
                uf,
                hh,
                featureEmbeddings,
                featureDimensions
              );
              candidates.push({ score: s, rel: p.rel, isPos: true });
              posScores.push(s);
            }

            for (const mid of negatives) {
              const movieVector = movieVectors.get(mid);
              if (!movieVector) continue;
              const mf = movieFeaturesMap.get(mid);
              if (!mf) continue;
              const hh: HouseholdFeatures = { otherUserRatings: new Map(), consensusScore: 0 };
              const s = predictRating(
                userVector,
                movieVector,
                userBiases.get(userId) ?? 0,
                movieBiases.get(mid) ?? 0,
                globalMean,
                mf,
                uf,
                hh,
                featureEmbeddings,
                featureDimensions
              );
              candidates.push({ score: s, rel: 0, isPos: false });
              negScores.push(s);
            }

            if (candidates.length === 0 || posScores.length === 0 || negScores.length === 0) continue;

            candidates.sort((a, b) => b.score - a.score);
            const relByRank = candidates.map((c) => c.rel);
            const binByRank = candidates.map((c) => c.rel >= epochEvalPositiveThreshold);

            mlValNdcg += ndcgAtK(relByRank, epochEvalK);
            mlValMap += mapAtK(binByRank, epochEvalK);
            mlValHit += binByRank.slice(0, epochEvalK).some(Boolean) ? 1 : 0;
            mlValAuc += aucFromScores(posScores, negScores);
            mlEvalUsers++;
          }

          if (mlEvalUsers > 0) {
            mlValNdcg /= mlEvalUsers;
            mlValMap /= mlEvalUsers;
            mlValHit /= mlEvalUsers;
            mlValAuc /= mlEvalUsers;
          }
        }

        console.log(
          `[MF Train] Epoch ${epoch + 1}/${epochs}: RMSE=${rmse.toFixed(4)} valRMSE=${validationRmse.toFixed(4)}` +
            (evalUsers > 0
              ? ` valNDCG@${epochEvalK}=${valNdcg.toFixed(4)} valMAP@${epochEvalK}=${valMap.toFixed(4)} valHit@${epochEvalK}=${valHit.toFixed(4)} valAUC=${valAuc.toFixed(4)}`
              : ``) +
            (mlEvalUsers > 0
              ? ` mlNDCG@${epochEvalK}=${mlValNdcg.toFixed(4)} mlMAP@${epochEvalK}=${mlValMap.toFixed(4)} mlHit@${epochEvalK}=${mlValHit.toFixed(4)} mlAUC=${mlValAuc.toFixed(4)}`
              : ``) +
            ` (JS)`
        );

        if (earlyStoppingEnabled && validationSet.length > 0) {
          const hasRanking = evalUsers > 0;
          const useCombined = earlyStoppingMetric === "combined" && hasRanking;
          const currentMetric = useCombined
            ? combinedEarlyStopScore({
                validationRmse,
                valNdcg,
                valMap,
                valHit,
                valAuc,
              })
            : validationRmse;

          const improved =
            useCombined
              ? currentMetric > bestVal + earlyStoppingMinDelta
              : currentMetric + earlyStoppingMinDelta < bestVal;
          if (improved) {
            bestVal = currentMetric;
            bestEpoch = epoch;
            epochsWithoutImprove = 0;

            // Deep copy maps (exclude nothing here; we only filter ML users on save).
            bestUserVectors = new Map();
            for (const [k, v] of userVectors.entries()) bestUserVectors.set(k, [...v]);
            bestMovieVectors = new Map();
            for (const [k, v] of movieVectors.entries()) bestMovieVectors.set(k, [...v]);
            bestUserBiases = new Map(userBiases.entries());
            bestMovieBiases = new Map(movieBiases.entries());
            bestFeatureEmbeddings = new Map();
            for (const [k, v] of featureEmbeddings.entries()) bestFeatureEmbeddings.set(k, { vector: [...v.vector], bias: v.bias });

            console.log(
              useCombined
                ? `[MF Train] EarlyStop checkpoint: best combined=${bestVal.toFixed(4)} at epoch ${bestEpoch + 1}`
                : `[MF Train] EarlyStop checkpoint: best valRMSE=${bestVal.toFixed(4)} at epoch ${bestEpoch + 1}`
            );
          } else {
            epochsWithoutImprove++;
            if (epochsWithoutImprove >= earlyStoppingPatience) {
              console.log(
                useCombined
                  ? `[MF Train] EarlyStop: no combined improvement for ${earlyStoppingPatience} epoch(s). Stopping at epoch ${epoch + 1}/${epochs}; best was epoch ${bestEpoch + 1} (combined=${bestVal.toFixed(4)}).`
                  : `[MF Train] EarlyStop: no valRMSE improvement for ${earlyStoppingPatience} epoch(s). Stopping at epoch ${epoch + 1}/${epochs}; best was epoch ${bestEpoch + 1} (valRMSE=${bestVal.toFixed(4)}).`
              );
              break;
            }
          }
        }
      }

      if (earlyStoppingEnabled && bestUserVectors && bestMovieVectors && bestUserBiases && bestMovieBiases && bestFeatureEmbeddings) {
        userVectors.clear();
        for (const [k, v] of bestUserVectors.entries()) userVectors.set(k, v);
        movieVectors.clear();
        for (const [k, v] of bestMovieVectors.entries()) movieVectors.set(k, v);
        userBiases.clear();
        for (const [k, v] of bestUserBiases.entries()) userBiases.set(k, v);
        movieBiases.clear();
        for (const [k, v] of bestMovieBiases.entries()) movieBiases.set(k, v);
        featureEmbeddings.clear();
        for (const [k, v] of bestFeatureEmbeddings.entries()) featureEmbeddings.set(k, v);
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
      await clusterAndSaveArchetypes(
        userVectors,
        householdUserVectors,
        mlRatings,
        userFeatureCache,
        archetypeClusters,
        archetypeDistance
      );
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
        regularization: legacyRegularization,
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
 * Reset a stale training lock (e.g., after container restart mid-training)
 */
export async function resetTrainingLock(): Promise<boolean> {
  const result = await prisma.mFModelMetadata.updateMany({
    where: { isTraining: true },
    data: { isTraining: false },
  });
  if (result.count > 0) {
    console.log("[MF] Reset stale training lock from previous container");
    return true;
  }
  return false;
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

function parseStoredVector(vectorJson: string): number[] | null {
  try {
    const parsed = JSON.parse(vectorJson) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const vector: number[] = [];
    for (const value of parsed) {
      const numeric = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(numeric)) return null;
      vector.push(numeric);
    }
    return vector.length > 0 ? vector : null;
  } catch {
    return null;
  }
}

function inferUserVectorFromMovieRatings(
  ratings: Array<{ movieId: string; rating: number }>,
  movieVectors: Map<string, number[]>
): number[] | null {
  let dims = 0;
  for (const vector of movieVectors.values()) {
    dims = vector.length;
    break;
  }
  if (dims <= 0) return null;

  const weighted = new Array(dims).fill(0);
  const unweighted = new Array(dims).fill(0);
  let absWeightSum = 0;
  let count = 0;

  for (const row of ratings) {
    const vector = movieVectors.get(row.movieId);
    if (!vector || vector.length !== dims) continue;
    const centered = (row.rating - 3) / 2; // 1..5 -> -1..1
    const w = Math.abs(centered) >= 0.05 ? centered : 0;
    for (let i = 0; i < dims; i++) {
      unweighted[i] += vector[i];
      if (w !== 0) {
        weighted[i] += vector[i] * w;
      }
    }
    absWeightSum += Math.abs(w);
    count++;
  }

  if (count === 0) return null;

  if (absWeightSum > 0) {
    return weighted.map((v) => v / absWeightSum);
  }
  return unweighted.map((v) => v / count);
}

/**
 * Refresh cached user summary fields and (re)assign the user to existing archetypes.
 * This does NOT run k-means; it only compares the user's vector to stored centroids.
 */
export async function refreshUserFeatureCacheAndArchetype(
  userId: string
): Promise<{ assigned: boolean; reason: string; archetypeId?: string }> {
  const [settings, genreRankings, movieRatings] = await Promise.all([
    prisma.userSettings.findUnique({
      where: { userId },
      select: { explorationFactor: true },
    }),
    prisma.genreRanking.findMany({
      where: { userId },
      orderBy: { rank: "asc" },
      take: 5,
      select: { genreId: true },
    }),
    prisma.movieRating.findMany({
      where: { userId, rating: { not: null }, notHeardOf: false },
      select: { movieId: true, rating: true },
    }),
  ]);

  const ratings = movieRatings.map((r) => r.rating as number);
  const ratingCount = ratings.length;
  const ratingMean = ratingCount > 0 ? ratings.reduce((a, b) => a + b, 0) / ratingCount : 3.0;
  const ratingVariance =
    ratingCount > 1
      ? ratings.reduce((sum, r) => sum + Math.pow(r - ratingMean, 2), 0) / (ratingCount - 1)
      : 0;
  const ratingStdDev = Math.sqrt(Math.max(0, ratingVariance));
  const ratingDisposition = classifyRatingDisposition(ratingMean, ratingStdDev, ratingCount);

  await prisma.userFeatureCache.upsert({
    where: { userId },
    create: {
      userId,
      explorationFactor: settings?.explorationFactor ?? 0.5,
      ratingMean,
      ratingStdDev,
      ratingCount,
      ratingDisposition,
      topGenreIds: JSON.stringify(genreRankings.map((g) => g.genreId)),
    },
    update: {
      explorationFactor: settings?.explorationFactor ?? 0.5,
      ratingMean,
      ratingStdDev,
      ratingCount,
      ratingDisposition,
      topGenreIds: JSON.stringify(genreRankings.map((g) => g.genreId)),
    },
  });

  const archetypesRaw = await prisma.viewerArchetype.findMany({
    select: { id: true, centroid: true },
  });
  if (archetypesRaw.length === 0) {
    return { assigned: false, reason: "no_archetypes" };
  }

  const archetypes = archetypesRaw
    .map((a) => ({ id: a.id, centroid: parseStoredVector(a.centroid) }))
    .filter((a): a is { id: string; centroid: number[] } => Array.isArray(a.centroid) && a.centroid.length > 0);
  if (archetypes.length === 0) {
    return { assigned: false, reason: "invalid_archetype_centroids" };
  }

  const userVectorRow = await prisma.latentVector.findUnique({
    where: { entityType_entityId: { entityType: "user", entityId: userId } },
    select: { vector: true },
  });

  let userVector = userVectorRow?.vector ? parseStoredVector(userVectorRow.vector) : null;

  if (!userVector && movieRatings.length > 0) {
    const movieVectorRows = await prisma.latentVector.findMany({
      where: {
        entityType: "movie",
        entityId: { in: movieRatings.map((r) => r.movieId) },
      },
      select: { entityId: true, vector: true },
    });

    const movieVectorMap = new Map<string, number[]>();
    for (const row of movieVectorRows) {
      const parsed = parseStoredVector(row.vector);
      if (parsed) {
        movieVectorMap.set(row.entityId, parsed);
      }
    }

    userVector = inferUserVectorFromMovieRatings(
      movieRatings.map((r) => ({ movieId: r.movieId, rating: r.rating as number })),
      movieVectorMap
    );
  }

  if (!userVector || vectorNorm(userVector) <= 0) {
    return { assigned: false, reason: "insufficient_user_vector" };
  }

  const userUnit = normalizeVector(userVector);
  const archetypeUnits = archetypes
    .map((a) => ({ id: a.id, centroid: normalizeVector(a.centroid) }))
    .filter((a) => vectorNorm(a.centroid) > 0);

  if (archetypeUnits.length === 0) {
    return { assigned: false, reason: "invalid_archetype_unit_vectors" };
  }

  const distances = archetypeUnits.map((a) => ({
    id: a.id,
    dist: cosineDistanceUnit(userUnit, a.centroid),
  }));
  distances.sort((a, b) => a.dist - b.dist);

  const best = distances[0];
  if (!best) {
    return { assigned: false, reason: "no_distance_match" };
  }

  const scores = softmaxNegDistances(distances);
  await prisma.userFeatureCache.updateMany({
    where: { userId },
    data: {
      archetypeId: best.id,
      archetypeScores: JSON.stringify(scores),
    },
  });

  return { assigned: true, reason: "matched_existing_archetypes", archetypeId: best.id };
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

function vectorNorm(a: number[]): number {
  let sumSq = 0;
  for (let i = 0; i < a.length; i++) sumSq += a[i] * a[i];
  return Math.sqrt(sumSq);
}

function normalizeVector(a: number[]): number[] {
  const n = vectorNorm(a);
  if (!Number.isFinite(n) || n <= 0) return a;
  return a.map((v) => v / n);
}

function cosineDistanceUnit(aUnit: number[], bUnit: number[]): number {
  // Assumes both vectors are already unit-normalized.
  const sim = dotProduct(aUnit, bUnit);
  // Numerical guard: sim can drift outside [-1,1] slightly.
  const clamped = Math.max(-1, Math.min(1, sim));
  return 1 - clamped;
}

function softmaxNegDistances(distances: { id: string; dist: number }[]): Record<string, number> {
  if (distances.length === 0) return {};
  const avg = distances.reduce((s, d) => s + d.dist, 0) / distances.length;
  const temp = Math.max(1e-6, avg); // scale to typical distance magnitude
  const exps = distances.map((d) => ({ id: d.id, v: Math.exp(-d.dist / temp) }));
  const sum = exps.reduce((s, e) => s + e.v, 0);
  if (sum <= 0) return {};
  const res: Record<string, number> = {};
  for (const e of exps) res[e.id] = e.v / sum;
  return res;
}

/**
 * K-means clustering on user latent vectors.
 * Returns cluster centroids and member assignments.
 */
function kMeansClustering(
  vectors: Map<string, number[]>,
  k: number,
  iterations: number = 20,
  distanceMetric: "euclidean" | "cosine" = "euclidean",
  seedKey: string = "kmeans"
): ClusterResult[] {
  const ids = Array.from(vectors.keys());
  const n = ids.length;
  if (n < k) return [];

  const dims = vectors.get(ids[0])!.length;

  // Convert to arrays for performance.
  const vecs: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const v = vectors.get(ids[i])!;
    vecs[i] = distanceMetric === "cosine" ? normalizeVector(v) : v;
  }

  const distFn = (a: number[], b: number[]) =>
    distanceMetric === "cosine" ? cosineDistanceUnit(a, b) : euclideanDistance(a, b);

  // Deterministic RNG.
  const rand = mulberry32(fnv1a32(`kmeans++:${seedKey}:${k}:${distanceMetric}`));

  // k-means++ initialization (deterministic, seeded)
  const centroids: number[][] = [];

  // Choose first centroid as the id with minimum stable hash (avoids needing a full sort).
  let firstIdx = 0;
  let bestHash = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const h = fnv1a32(`kmeans++:first:${seedKey}:${ids[i]}`);
    if (h < bestHash) {
      bestHash = h;
      firstIdx = i;
    }
  }
  centroids.push([...vecs[firstIdx]]);

  const minDistSq = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = distFn(vecs[i], centroids[0]);
    minDistSq[i] = Math.max(1e-12, d * d);
  }

  while (centroids.length < k) {
    let total = 0;
    for (let i = 0; i < n; i++) total += minDistSq[i];
    if (!Number.isFinite(total) || total <= 0) break;

    const pick = rand() * total;
    let acc = 0;
    let chosen = 0;
    for (let i = 0; i < n; i++) {
      acc += minDistSq[i];
      if (acc >= pick) {
        chosen = i;
        break;
      }
    }
    centroids.push([...vecs[chosen]]);

    // Update min distance to closest centroid.
    const newC = centroids[centroids.length - 1];
    for (let i = 0; i < n; i++) {
      const d = distFn(vecs[i], newC);
      const dsq = Math.max(1e-12, d * d);
      if (dsq < minDistSq[i]) minDistSq[i] = dsq;
    }
  }

  // Main k-means iterations.
  const assignments = new Int32Array(n);
  assignments.fill(-1);

  for (let iter = 0; iter < iterations; iter++) {
    // Assignment step
    for (let i = 0; i < n; i++) {
      const v = vecs[i];
      let minDist = Number.POSITIVE_INFINITY;
      let best = 0;
      for (let c = 0; c < centroids.length; c++) {
        const d = distFn(v, centroids[c]);
        if (d < minDist) {
          minDist = d;
          best = c;
        }
      }
      assignments[i] = best;
    }

    // Update step (accumulate sums for each cluster)
    const sums: number[][] = new Array(centroids.length);
    const counts = new Int32Array(centroids.length);
    for (let c = 0; c < centroids.length; c++) {
      sums[c] = new Array(dims).fill(0);
    }

    for (let i = 0; i < n; i++) {
      const c = assignments[i];
      counts[c] += 1;
      const v = vecs[i];
      const s = sums[c];
      for (let d = 0; d < dims; d++) {
        s[d] += v[d];
      }
    }

    for (let c = 0; c < centroids.length; c++) {
      const count = counts[c];
      if (count <= 0) continue;
      const s = sums[c];
      for (let d = 0; d < dims; d++) s[d] /= count;
      centroids[c] = distanceMetric === "cosine" ? normalizeVector(s) : s;
    }
  }

  // Build results, filter tiny clusters
  const membersByCluster: string[][] = new Array(centroids.length);
  for (let c = 0; c < centroids.length; c++) membersByCluster[c] = [];
  for (let i = 0; i < n; i++) {
    const c = assignments[i];
    if (c >= 0 && c < membersByCluster.length) membersByCluster[c].push(ids[i]);
  }

  const results: ClusterResult[] = [];
  for (let c = 0; c < centroids.length; c++) {
    const members = membersByCluster[c];
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
  genreIdToName: Map<string, string>,
  globalGenreShare: Map<string, number>
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

  // "Distinctive" genres: lift over global share rather than raw frequency.
  // This avoids every archetype being "Drama ..." just because Drama is common globally.
  const topGenres = Array.from(genreCounts.entries())
    .map(([gid, count]) => {
      const clusterShare = totalGenreHits > 0 ? count / totalGenreHits : 0;
      const globalShare = globalGenreShare.get(gid) ?? 0;
      const lift = clusterShare - globalShare;
      return { gid, name: genreIdToName.get(gid) || "Unknown", lift, clusterShare };
    })
    .sort((a, b) => b.lift - a.lift)
    .slice(0, 5)
    .map((g) => ({
      name: g.name,
      // Keep a 0..1-ish number for UI. Lift can be negative; clamp at 0.
      score: Math.max(0, g.lift),
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

  let name = `The ${genreLabel} ${personality}`;

  // Improve naming diversity for common "Action/Adventure/Drama" overlaps.
  // These labels are intentionally opinionated to avoid repetitive "Drama Enthusiast N".
  const hasGenre = (g: string) => topGenres.some((x) => x.name === g);
  if (hasGenre("Adventure") && hasGenre("Science Fiction")) {
    name = "The Blockbuster Voyager";
  } else if (hasGenre("Action") && hasGenre("Crime")) {
    name = "The Neo-Noir Adrenaline Seeker";
  } else if (hasGenre("Drama") && hasGenre("Crime") && hasGenre("History")) {
    name = "The Prestige Crime Historian";
  } else if (hasGenre("Drama") && hasGenre("Science Fiction") && hasGenre("Mystery")) {
    name = "The Cerebral Sci-Fi Sleuth";
  } else if (hasGenre("Drama") && hasGenre("Romance")) {
    name = "The Intimate Character Reader";
  } else if (hasGenre("Romance") && hasGenre("Science Fiction")) {
    name = "The Sentimental Futurist";
  } else if (hasGenre("Action") && hasGenre("Adventure") && hasGenre("Fantasy")) {
    name = "The Epic Quest Loyalist";
  }

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
  k: number = 8,
  distanceMetric: "euclidean" | "cosine" = "cosine"
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
  const clusters = kMeansClustering(mlVectors, k, 20, distanceMetric, "ml-users");
  console.log(`[MF Train] Found ${clusters.length} valid clusters`);

  if (clusters.length === 0) return;

  // Load genre names for analysis
  const genres = await prisma.genre.findMany({ select: { id: true, name: true } });
  const genreIdToName = new Map(genres.map((g) => [g.id, g.name]));

  // Global genre share across all above-mean ML ratings (for lift-based naming).
  const globalGenreCounts = new Map<string, number>();
  let globalHits = 0;
  for (const r of mlRatings) {
    if (r.rating < 0) continue;
    for (const gid of r.movieFeatures.genreIds) {
      globalGenreCounts.set(gid, (globalGenreCounts.get(gid) || 0) + 1);
      globalHits++;
    }
  }
  const globalGenreShare = new Map<string, number>();
  for (const [gid, count] of globalGenreCounts.entries()) {
    globalGenreShare.set(gid, globalHits > 0 ? count / globalHits : 0);
  }

  // Analyze and save each cluster
  const existingArchetypes = await prisma.viewerArchetype.findMany({
    select: { id: true, name: true, centroid: true },
  });

  const existingForMatching = existingArchetypes
    .map((a) => ({ id: a.id, name: a.name, centroid: parseStoredVector(a.centroid) }))
    .filter(
      (a): a is { id: string; name: string; centroid: number[] } =>
        Array.isArray(a.centroid) && a.centroid.length === clusters[0]?.centroid.length
    );

  // Greedy one-to-one cluster matching so manual/curated labels remain stable between retrains.
  const clusterMatches = new Map<number, { id: string; name: string }>();
  const usedExistingIds = new Set<string>();
  for (let clusterIndex = 0; clusterIndex < clusters.length; clusterIndex++) {
    const cluster = clusters[clusterIndex];
    const clusterCentroid =
      distanceMetric === "cosine" ? normalizeVector(cluster.centroid) : cluster.centroid;

    let best: { id: string; name: string; dist: number } | null = null;
    for (const existing of existingForMatching) {
      if (usedExistingIds.has(existing.id)) continue;
      const existingCentroid =
        distanceMetric === "cosine" ? normalizeVector(existing.centroid) : existing.centroid;
      if (existingCentroid.length !== clusterCentroid.length) continue;
      const dist =
        distanceMetric === "cosine"
          ? cosineDistanceUnit(clusterCentroid, existingCentroid)
          : euclideanDistance(clusterCentroid, existingCentroid);
      if (!Number.isFinite(dist)) continue;
      if (!best || dist < best.dist) {
        best = { id: existing.id, name: existing.name, dist };
      }
    }

    if (best) {
      clusterMatches.set(clusterIndex, { id: best.id, name: best.name });
      usedExistingIds.add(best.id);
    }
  }

  const savedNames = new Set<string>(existingArchetypes.map((a) => a.name));
  const archetypeIds: { id: string; centroid: number[] }[] = [];

  for (let clusterIndex = 0; clusterIndex < clusters.length; clusterIndex++) {
    const cluster = clusters[clusterIndex];
    const analysis = analyzeCluster(cluster, mlRatings, userFeatureCache, genreIdToName, globalGenreShare);

    const matched = clusterMatches.get(clusterIndex);
    const archetype = matched
      ? await prisma.viewerArchetype.update({
          where: { id: matched.id },
          data: {
            // Keep stable/manual labels when cluster identity is matched.
            description: analysis.description,
            centroid: JSON.stringify(cluster.centroid),
            clusterSize: cluster.memberIds.length,
            topGenres: JSON.stringify(analysis.topGenres),
            disposition: analysis.disposition,
            traits: JSON.stringify(analysis.traits),
          },
        })
      : await (async () => {
          let finalName = analysis.name;
          let suffix = 2;
          while (savedNames.has(finalName)) {
            finalName = `${analysis.name} ${suffix}`;
            suffix++;
          }
          savedNames.add(finalName);
          return prisma.viewerArchetype.create({
            data: {
              name: finalName,
              description: analysis.description,
              centroid: JSON.stringify(cluster.centroid),
              clusterSize: cluster.memberIds.length,
              topGenres: JSON.stringify(analysis.topGenres),
              disposition: analysis.disposition,
              traits: JSON.stringify(analysis.traits),
            },
          });
        })();

    archetypeIds.push({ id: archetype.id, centroid: cluster.centroid });
  }

  // Delete stale archetypes not in current set
  const currentIds = archetypeIds.map((a) => a.id);
  await prisma.viewerArchetype.deleteMany({
    where: { id: { notIn: currentIds } },
  });

  // Match household users to nearest archetype
  let matched = 0;
  const archetypeCentroidsForDistance =
    distanceMetric === "cosine"
      ? archetypeIds.map((a) => ({ ...a, centroid: normalizeVector(a.centroid) }))
      : archetypeIds;

  for (const [userId, userVec] of householdUserVectors) {
    const userVecForDistance = distanceMetric === "cosine" ? normalizeVector(userVec) : userVec;
    let minDist = Infinity;
    let bestId: string | null = null;
    const dists: { id: string; dist: number }[] = [];
    for (const arch of archetypeCentroidsForDistance) {
      const dist =
        distanceMetric === "cosine"
          ? cosineDistanceUnit(userVecForDistance, arch.centroid)
          : euclideanDistance(userVecForDistance, arch.centroid);
      dists.push({ id: arch.id, dist });
      if (dist < minDist) {
        minDist = dist;
        bestId = arch.id;
      }
    }
    if (bestId) {
      const scores = softmaxNegDistances(dists);
      await prisma.userFeatureCache.updateMany({
        where: { userId },
        data: { archetypeId: bestId, archetypeScores: JSON.stringify(scores) },
      });
      matched++;
    }
  }

  console.log(
    `[MF Train] Saved ${archetypeIds.length} archetypes, matched ${matched} household users`
  );
}
