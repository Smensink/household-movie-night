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

// Model hyperparameters
const DEFAULT_LATENT_DIMENSIONS = 50;
const DEFAULT_FEATURE_DIMENSIONS = 16;
const DEFAULT_LEARNING_RATE = 0.005;
const DEFAULT_REGULARIZATION = 0.02;
const DEFAULT_EPOCHS = 20;
const MIN_RATINGS_TO_TRAIN = 20;
const VALIDATION_SPLIT = 0.1;

// Feature types
type FeatureType =
  | "genre"
  | "era"
  | "studio"
  | "actor"
  | "director"
  | "popularity_bin"
  | "runtime_bin"
  | "vote_avg_bin"
  | "vote_count_bin"
  | "user_exploration"
  | "user_rating_pattern"
  | "household_consensus";

interface Rating {
  userId: string;
  movieId: string;
  rating: number;
  movieFeatures: MovieFeatures;
  userFeatures: UserFeatures;
  householdFeatures: HouseholdFeatures;
}

interface MovieFeatures {
  genreIds: string[];
  era: string | null;
  studioIds: string[];
  actorIds: string[];
  directorIds: string[];
  popularityBin: string;
  runtimeBin: string;
  voteAvgBin: string;
  voteCountBin: string;
}

interface UserFeatures {
  explorationFactor: number;
  ratingMean: number;
  ratingStdDev: number;
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

function binRatingPattern(mean: number, stdDev: number): string {
  if (stdDev < 0.5) return "consistent";
  if (mean > 3.5) return "generous";
  if (mean < 2.5) return "critical";
  return "varied";
}

/**
 * Get feature key for embedding lookup
 */
function getFeatureKey(type: FeatureType, id: string): string {
  return `${type}:${id}`;
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

  // Binned features
  const binFeatures = [
    { type: "popularity_bin" as FeatureType, id: movieFeatures.popularityBin, weight: 0.1 },
    { type: "runtime_bin" as FeatureType, id: movieFeatures.runtimeBin, weight: 0.05 },
    { type: "vote_avg_bin" as FeatureType, id: movieFeatures.voteAvgBin, weight: 0.15 },
    { type: "vote_count_bin" as FeatureType, id: movieFeatures.voteCountBin, weight: 0.2 }, // How mainstream/known the movie is
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

  const ratingPatternBin = binRatingPattern(userFeatures.ratingMean, userFeatures.ratingStdDev);
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
  const upserts: Promise<unknown>[] = [];

  for (const [userId, vector] of vectors.userVectors) {
    upserts.push(
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
    upserts.push(
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
    upserts.push(
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

  // Process in batches
  const batchSize = 100;
  for (let i = 0; i < upserts.length; i += batchSize) {
    await Promise.all(upserts.slice(i, i + batchSize));
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

  return {
    explorationFactor: settings?.explorationFactor ?? 0.5,
    ratingMean,
    ratingStdDev: Math.sqrt(ratingVariance),
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

  // Check if already training
  const metadata = await prisma.mFModelMetadata.findFirst();
  if (metadata?.isTraining) {
    throw new Error("Model is already being trained");
  }

  // Mark as training
  await prisma.mFModelMetadata.upsert({
    where: { id: metadata?.id ?? "default" },
    create: { id: "default", isTraining: true, latentDimensions, featureDimensions },
    update: { isTraining: true },
  });

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
            popularity: true,
            runtime: true,
            voteAverage: true,
            voteCount: true,
            genres: { select: { genreId: true } },
            studios: { select: { studioId: true }, take: 3 },
            cast: { select: { personId: true }, take: 5, orderBy: { castOrder: "asc" } },
            crew: { where: { job: "Director" }, select: { personId: true }, take: 2 },
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
    const cacheUpserts = Array.from(userFeatureCache.entries()).map(([userId, features]) =>
      prisma.userFeatureCache.upsert({
        where: { userId },
        create: {
          userId,
          explorationFactor: features.explorationFactor,
          ratingMean: features.ratingMean,
          ratingStdDev: features.ratingStdDev,
          ratingCount: rawRatings.filter((r) => r.userId === userId).length,
          topGenreIds: JSON.stringify(features.topGenreIds),
        },
        update: {
          explorationFactor: features.explorationFactor,
          ratingMean: features.ratingMean,
          ratingStdDev: features.ratingStdDev,
          ratingCount: rawRatings.filter((r) => r.userId === userId).length,
          topGenreIds: JSON.stringify(features.topGenreIds),
        },
      })
    );
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
        studioIds: r.movie.studios.map((s) => s.studioId),
        actorIds: r.movie.cast.map((c) => c.personId),
        directorIds: r.movie.crew.map((c) => c.personId),
        popularityBin: binPopularity(r.movie.popularity),
        runtimeBin: binRuntime(r.movie.runtime),
        voteAvgBin: binVoteAverage(r.movie.voteAverage),
        voteCountBin: binVoteCount(r.movie.voteCount),
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
        rating: r.rating!,
        movieFeatures,
        userFeatures,
        householdFeatures,
      };
    });

    // Calculate global mean
    const globalMean = ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length;

    // Split into training and validation
    const shuffled = [...ratings].sort(() => Math.random() - 0.5);
    const validationSize = Math.floor(shuffled.length * VALIDATION_SPLIT);
    const validationSet = shuffled.slice(0, validationSize);
    const trainingSet = shuffled.slice(validationSize);

    // Collect all unique features
    const allFeatures = new Set<string>();
    for (const r of ratings) {
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
      allFeatures.add(getFeatureKey("popularity_bin", r.movieFeatures.popularityBin));
      allFeatures.add(getFeatureKey("runtime_bin", r.movieFeatures.runtimeBin));
      allFeatures.add(getFeatureKey("vote_avg_bin", r.movieFeatures.voteAvgBin));
      allFeatures.add(getFeatureKey("vote_count_bin", r.movieFeatures.voteCountBin));
      allFeatures.add(getFeatureKey("user_exploration", binExploration(r.userFeatures.explorationFactor)));
      allFeatures.add(getFeatureKey("user_rating_pattern", binRatingPattern(r.userFeatures.ratingMean, r.userFeatures.ratingStdDev)));
      if (r.householdFeatures.consensusScore > 0) {
        const consensusBin = r.householdFeatures.consensusScore > 3.5 ? "positive" : r.householdFeatures.consensusScore < 2.5 ? "negative" : "neutral";
        allFeatures.add(getFeatureKey("household_consensus", consensusBin));
      }
    }

    // Get unique users and movies
    const movieIds = new Set(ratings.map((r) => r.movieId));

    // Load existing vectors or initialize new ones
    const existing = await loadLatentVectors(featureDimensions);

    const userVectors = new Map<string, number[]>();
    const movieVectors = new Map<string, number[]>();
    const userBiases = new Map<string, number>();
    const movieBiases = new Map<string, number>();
    const featureEmbeddings = new Map<string, { vector: number[]; bias: number }>();

    // Initialize or reuse vectors
    for (const userId of userIds) {
      userVectors.set(userId, existing.userVectors.get(userId) ?? initializeVector(latentDimensions));
      userBiases.set(userId, existing.userBiases.get(userId) ?? 0);
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

    // Training loop
    let rmse = 0;
    let validationRmse = 0;

    for (let epoch = 0; epoch < epochs; epoch++) {
      // Shuffle training data
      const shuffledTraining = [...trainingSet].sort(() => Math.random() - 0.5);
      let totalSquaredError = 0;

      for (const rating of shuffledTraining) {
        const userVector = userVectors.get(rating.userId)!;
        const movieVector = movieVectors.get(rating.movieId)!;
        const userBias = userBiases.get(rating.userId)!;
        const movieBias = movieBiases.get(rating.movieId)!;

        // Compute prediction and error
        const predicted = predictRating(
          userVector,
          movieVector,
          userBias,
          movieBias,
          globalMean,
          rating.movieFeatures,
          rating.userFeatures,
          rating.householdFeatures,
          featureEmbeddings,
          featureDimensions
        );
        const error = rating.rating - predicted;
        totalSquaredError += error * error;

        // Update biases
        userBiases.set(rating.userId, userBias + learningRate * (error - regularization * userBias));
        movieBiases.set(rating.movieId, movieBias + learningRate * (error - regularization * movieBias));

        // Update latent vectors
        for (let k = 0; k < latentDimensions; k++) {
          const userK = userVector[k];
          const movieK = movieVector[k];
          userVector[k] += learningRate * (error * movieK - regularization * userK);
          movieVector[k] += learningRate * (error * userK - regularization * movieK);
        }

        // Update feature embeddings
        const featuresToUpdate: string[] = [];
        for (const genreId of rating.movieFeatures.genreIds) {
          featuresToUpdate.push(getFeatureKey("genre", genreId));
        }
        if (rating.movieFeatures.era) {
          featuresToUpdate.push(getFeatureKey("era", rating.movieFeatures.era));
        }
        for (const studioId of rating.movieFeatures.studioIds.slice(0, 2)) {
          featuresToUpdate.push(getFeatureKey("studio", studioId));
        }
        for (const actorId of rating.movieFeatures.actorIds.slice(0, 3)) {
          featuresToUpdate.push(getFeatureKey("actor", actorId));
        }
        for (const directorId of rating.movieFeatures.directorIds) {
          featuresToUpdate.push(getFeatureKey("director", directorId));
        }
        featuresToUpdate.push(getFeatureKey("popularity_bin", rating.movieFeatures.popularityBin));
        featuresToUpdate.push(getFeatureKey("runtime_bin", rating.movieFeatures.runtimeBin));
        featuresToUpdate.push(getFeatureKey("vote_avg_bin", rating.movieFeatures.voteAvgBin));
        featuresToUpdate.push(getFeatureKey("vote_count_bin", rating.movieFeatures.voteCountBin));
        featuresToUpdate.push(getFeatureKey("user_exploration", binExploration(rating.userFeatures.explorationFactor)));
        featuresToUpdate.push(getFeatureKey("user_rating_pattern", binRatingPattern(rating.userFeatures.ratingMean, rating.userFeatures.ratingStdDev)));

        for (const key of featuresToUpdate) {
          const emb = featureEmbeddings.get(key);
          if (emb) {
            emb.bias += learningRate * (error * 0.1 - regularization * emb.bias);
            for (let k = 0; k < featureDimensions; k++) {
              emb.vector[k] += learningRate * (error * 0.05 - regularization * emb.vector[k]);
            }
          }
        }
      }

      rmse = Math.sqrt(totalSquaredError / trainingSet.length);

      // Calculate validation RMSE
      let validationSquaredError = 0;
      for (const rating of validationSet) {
        const userVector = userVectors.get(rating.userId);
        const movieVector = movieVectors.get(rating.movieId);
        if (!userVector || !movieVector) continue;

        const predicted = predictRating(
          userVector,
          movieVector,
          userBiases.get(rating.userId) ?? 0,
          movieBiases.get(rating.movieId) ?? 0,
          globalMean,
          rating.movieFeatures,
          rating.userFeatures,
          rating.householdFeatures,
          featureEmbeddings,
          featureDimensions
        );
        validationSquaredError += Math.pow(rating.rating - predicted, 2);
      }
      validationRmse = validationSet.length > 0 ? Math.sqrt(validationSquaredError / validationSet.length) : rmse;
    }

    // Save trained vectors
    await saveLatentVectors({
      userVectors,
      movieVectors,
      userBiases,
      movieBiases,
      featureEmbeddings,
      globalMean,
    });

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
      ratingsProcessed: ratings.length,
      usersProcessed: userIds.size,
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
    { type: "vote_count_bin" as FeatureType, id: movieFeatures.voteCountBin, weight: 0.25 }, // Mainstream indicator
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
    getFeatureKey("user_rating_pattern", binRatingPattern(userFeatures.ratingMean, userFeatures.ratingStdDev))
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
        popularity: true,
        runtime: true,
        voteAverage: true,
        voteCount: true,
        genres: { select: { genreId: true } },
        studios: { select: { studioId: true }, take: 3 },
        cast: { select: { personId: true }, take: 5, orderBy: { castOrder: "asc" } },
        crew: { where: { job: "Director" }, select: { personId: true }, take: 2 },
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
      studioIds: movie.studios.map((s) => s.studioId),
      actorIds: movie.cast.map((c) => c.personId),
      directorIds: movie.crew.map((c) => c.personId),
      popularityBin: binPopularity(movie.popularity),
      runtimeBin: binRuntime(movie.runtime),
      voteAvgBin: binVoteAverage(movie.voteAverage),
      voteCountBin: binVoteCount(movie.voteCount),
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
