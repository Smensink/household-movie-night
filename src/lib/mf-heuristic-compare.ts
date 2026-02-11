import { getAlgorithmSettings } from "@/lib/algorithm-settings";
import { getModelMetadata, getPredictedRatingsForUser } from "@/lib/matrix-factorization";
import { averageAffinityForIds, buildDiscoveryPreferenceProfile } from "@/lib/preference-profile";
import { prisma } from "@/lib/prisma";

type HeuristicVsMFEvalUserResult = {
  userId: string;
  trainingCount: number;
  validationCount: number;
  heuristicRmse: number;
  heuristicMae: number;
  mfRmse: number;
  mfMae: number;
  mfCoverage: number;
};

export type HeuristicVsMFEvalConfig = {
  validationSplitPercent: number; // default 20
  minValidationRatingsPerUser: number; // default 5
  maxUsers: number | null; // default null
  includePerUser: boolean; // default false
  tuneHybrid: boolean; // default false
};

type AdaptiveBlendParams = {
  minWarm: number;
  maxWarm: number;
  minCold: number;
  maxCold: number;
  explorationLift: number;
  evidencePower: number;
  minFloorMultiplier: number;
};

type HybridStrategyResult = {
  strategy: string;
  params?: AdaptiveBlendParams;
  rmse: number;
  mae: number;
  mfWeightMean: number;
  mfWeightP90: number;
  mfWeightMax: number;
  hybridBeatsMfRate: number;
  hybridBeatsHeuristicRate: number;
};

export type HeuristicVsMFEvalResult = {
  model: Awaited<ReturnType<typeof getModelMetadata>>;
  config: HeuristicVsMFEvalConfig;
  usersConsidered: number;
  usersEvaluated: number;
  ratingRowsEvaluated: number;
  metrics: {
    heuristicRmse: number | null;
    heuristicMae: number | null;
    mfRmse: number | null;
    mfMae: number | null;
    mfCoverage: number | null;
    mfBeatsHeuristicRate: number | null;
    heuristicBeatsMfRate: number | null;
    tieRate: number | null;
    hybridRmse: number | null;
    hybridMae: number | null;
    hybridBeatsMfRate: number | null;
    hybridBeatsHeuristicRate: number | null;
  };
  hybridStrategy?: {
    strategy: string;
    params?: AdaptiveBlendParams;
    mfWeightMean: number;
    mfWeightP90: number;
    mfWeightMax: number;
  };
  tuning?: {
    objective: "rmse_then_mae";
    strategiesSearched: number;
    recommended: HybridStrategyResult;
    topStrategies: HybridStrategyResult[];
  };
  caveats: string[];
  perUser?: HeuristicVsMFEvalUserResult[];
  timingMs: number;
};

type EvalMovie = {
  id: string;
  tmdbId: string | null;
  isMlOnly: boolean;
  year: number | null;
  releaseDate: Date | null;
  popularity: number | null;
  voteAverage: number | null;
  voteCount: number | null;
  mlRatingCount: number | null;
  imdbRating: number | null;
  letterboxdRating: number | null;
  genres: Array<{ genreId: string }>;
  cast: Array<{ personId: string }>;
  crew: Array<{ personId: string }>;
  studios: Array<{ studioId: string }>;
  ratings: Array<{
    userId: string;
    rating: number | null;
    hasSeen: boolean;
    notHeardOf: boolean;
  }>;
  plexAvailability: { available: boolean } | null;
  radarrSync: { available: boolean } | null;
};

type HybridEvalRow = {
  actual: number;
  heuristicPred: number;
  mfPred: number;
  hasMfPrediction: boolean;
  coldStartUser: boolean;
  explorationFactor: number;
  heuristicEvidence: number;
};

function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h >>> 0;
}

function isInValidationSplit(userId: string, movieId: string, pct: number): boolean {
  const p = Math.max(1, Math.min(99, Math.floor(pct)));
  return fnv1a32(`${userId}:${movieId}`) % 100 < p;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function normalizeRating(rating: number): number {
  return (rating - 3) / 2;
}

function computeColdStartUser(profile: Awaited<ReturnType<typeof buildDiscoveryPreferenceProfile>>): boolean {
  return profile.userRatedMovieIds.size < 10 && profile.genreAffinity.size < 5;
}

function computeEffectiveExplorationFactor(
  explorationFactor: number,
  coldStartUser: boolean
): number {
  return coldStartUser ? Math.max(0.7, explorationFactor) : Math.pow(explorationFactor, 1.5);
}

function getReleaseYear(movie: { releaseDate: Date | null; year: number | null }, fallbackYear: number): number {
  if (movie.releaseDate) return movie.releaseDate.getFullYear();
  if (movie.year) return movie.year;
  return fallbackYear;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = clamp(p, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const t = rank - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
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
      score01 = ratingQuality * 0.5 + (1 - mainstream) * 0.4 + voteConfidence * 0.1;
      break;
    case "balanced":
    default:
      score01 = 0.5;
      break;
  }

  return score01 * 2 - 1;
}

function computeHeuristicRawScore(
  movie: EvalMovie,
  userId: string,
  profile: Awaited<ReturnType<typeof buildDiscoveryPreferenceProfile>>,
  tuning: Awaited<ReturnType<typeof getAlgorithmSettings>>["movieDiscovery"],
  excludeSelfSignals: boolean
): number {
  const now = new Date();
  const currentYear = now.getFullYear();
  const ratedMovieCount = profile.userRatedMovieIds.size;
  const coldStartUser = ratedMovieCount < 10 && profile.genreAffinity.size < 5;

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

  // Avoid direct leakage in "predict previous ratings" evaluation.
  const movieSignal = 0;

  const ratingsForSignals = movie.ratings.filter((rating) => {
    if (rating.notHeardOf || rating.rating === null) return false;
    if (excludeSelfSignals && rating.userId === userId) return false;
    return true;
  });

  const householdRatingSignal =
    ratingsForSignals.length > 0
      ? average(ratingsForSignals.map((rating) => normalizeRating(rating.rating as number)))
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
      : movie.studios.filter((studio) => profile.userRatedStudioIds.has(studio.studioId)).length /
        movie.studios.length;

  const noveltySignal =
    1 - (actorFamiliarity * 0.5 + directorFamiliarity * 0.2 + studioFamiliarity * 0.3);

  const qualityWeight = coldStartUser ? 0.85 : 0.6;
  const popularityWeight = coldStartUser ? 0.15 : 0.4;
  const qualitySignal =
    clamp((movie.voteAverage ?? 0) / 10, 0, 1) * qualityWeight +
    clamp((movie.popularity ?? 0) / 100, 0, 1) * popularityWeight;

  const userRating = excludeSelfSignals
    ? undefined
    : movie.ratings.find((rating) => rating.userId === userId);
  const unseenBonus = userRating?.hasSeen ? -0.35 : 0.15;

  const imdbRating = movie.imdbRating ?? 0;
  const tmdbRating = movie.voteAverage ?? 0;
  const mlRating = movie.letterboxdRating != null ? movie.letterboxdRating * 2 : 0;
  const bestRating = Math.max(imdbRating, tmdbRating, mlRating);
  const voteCount = movie.isMlOnly ? movie.mlRatingCount ?? 0 : movie.voteCount ?? 0;
  const releaseYear = getReleaseYear(movie, currentYear - 10);
  const recentness = clamp((releaseYear - (currentYear - 20)) / 20, 0, 1);
  const mainstream = clamp((movie.popularity ?? 0) / 120, 0, 1);
  const ratingQuality = clamp(bestRating / 10, 0, 1);
  const voteConfidence = clamp(Math.log10(voteCount + 1) / 5, 0, 1);
  const sourceSignal = computeSourceSignal(profile.discoverySourcePref, {
    mainstream,
    recentness,
    ratingQuality,
    voteConfidence,
  });
  const isIndieDarlings = profile.discoverySourcePref === "indie_darlings";

  let mainstreamBonus = 0;
  if (imdbRating >= 8.0) mainstreamBonus = 0.7;
  else if (imdbRating >= 7.5) mainstreamBonus = 0.5;
  else if (imdbRating >= 7.0) mainstreamBonus = 0.35;
  else if (bestRating >= 6.5) mainstreamBonus = 0.15;

  const effectiveExplorationFactor = coldStartUser
    ? Math.max(0.7, profile.explorationFactor)
    : Math.pow(profile.explorationFactor, 1.5);

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
  const discoverySignal = discoveryBase * 2 - 1 + unseenBonus;

  const strongDislikes = movie.ratings.filter((rating) => {
    if (rating.notHeardOf || rating.rating === null) return false;
    if (excludeSelfSignals && rating.userId === userId) return false;
    return rating.rating <= 2;
  }).length;
  const dislikePenalty = strongDislikes > 0 ? strongDislikes * tuning.dislikePenalty : 0;

  const availabilitySignal = movie.radarrSync?.available || movie.plexAvailability?.available ? 1 : 0;

  const genreExplorationBonus = movie.genres.some((genre) => !profile.genreAffinity.has(genre.genreId))
    ? 0.15
    : 0;

  const confidenceWeight = coldStartUser ? 0.5 : 1.0;
  const scaledMainstreamBonus = mainstreamBonus * (1 - effectiveExplorationFactor);
  const indieMainstreamPenalty = isIndieDarlings ? mainstream * 0.9 + recentness * 0.2 : 0;

  let radarrProximityBoost = 0;
  if (movie.tmdbId && !movie.radarrSync) {
    const householdSize = profile.householdUserIds.length;
    const threshold = Math.floor(householdSize / 2) + 1;
    const nearThresholdVotes = movie.ratings.filter((rating) => {
      if (rating.userId === userId && excludeSelfSignals) return false;
      return !rating.notHeardOf && rating.rating !== null && rating.rating >= 3.5 && !rating.hasSeen;
    }).length;
    const votesNeeded = threshold - nearThresholdVotes;
    if (votesNeeded === 1) radarrProximityBoost = tuning.radarrProximityBoost;
    else if (votesNeeded === 2 && nearThresholdVotes > 0) {
      radarrProximityBoost = tuning.radarrProximityBoost * 0.5;
    }
  }

  const heuristicScore =
    preferenceSignal * tuning.preferenceWeight * (1 - effectiveExplorationFactor) +
    discoverySignal * tuning.discoveryWeight * effectiveExplorationFactor +
    (isIndieDarlings ? 0 : scaledMainstreamBonus) +
    availabilitySignal * tuning.availabilityBonus +
    -indieMainstreamPenalty +
    dislikePenalty +
    genreExplorationBonus * effectiveExplorationFactor +
    radarrProximityBoost;

  return heuristicScore * confidenceWeight;
}

function computeHeuristicEvidence(
  movie: EvalMovie,
  userId: string,
  profile: Awaited<ReturnType<typeof buildDiscoveryPreferenceProfile>>
): number {
  const householdPeerCount = Math.max(1, profile.householdUserIds.length - 1);
  const explicitRatingsFromPeers = movie.ratings.filter(
    (rating) => rating.userId !== userId && !rating.notHeardOf && rating.rating !== null
  );
  const explicitRatingCoverage = explicitRatingsFromPeers.length / householdPeerCount;

  const genreAffinityCoverage =
    movie.genres.length > 0
      ? movie.genres.filter((genre) => profile.genreAffinity.has(genre.genreId)).length /
        movie.genres.length
      : 0;
  const actorAffinityCoverage =
    movie.cast.length > 0
      ? movie.cast.filter((castMember) => profile.actorAffinity.has(castMember.personId)).length /
        movie.cast.length
      : 0;
  const directorAffinityCoverage =
    movie.crew.length > 0
      ? movie.crew.filter((crewMember) => profile.directorAffinity.has(crewMember.personId)).length /
        movie.crew.length
      : 0;
  const studioAffinityCoverage =
    movie.studios.length > 0
      ? movie.studios.filter((studio) => profile.studioAffinity.has(studio.studioId)).length /
        movie.studios.length
      : 0;

  // In held-out backtests we deliberately avoid counting direct user-movie affinity as evidence
  // to prevent target-row leakage from prior explicit ratings.
  const movieAffinityKnown = 0;

  const affinityEvidence = clamp(
    genreAffinityCoverage * 0.35 +
      actorAffinityCoverage * 0.2 +
      directorAffinityCoverage * 0.15 +
      studioAffinityCoverage * 0.15 +
      movieAffinityKnown * 0.15,
    0,
    1
  );
  const explicitEvidence = clamp(explicitRatingCoverage, 0, 1);
  return clamp(explicitEvidence * 0.55 + affinityEvidence * 0.45, 0, 1);
}

function computeAdaptiveMfWeightFromParams(args: {
  mfConfidence: number;
  hasPrediction: boolean;
  coldStartUser: boolean;
  heuristicEvidence: number;
  explorationFactor: number;
  params: AdaptiveBlendParams;
}): number {
  const {
    mfConfidence,
    hasPrediction,
    coldStartUser,
    heuristicEvidence,
    explorationFactor,
    params,
  } = args;
  if (!hasPrediction || mfConfidence <= 0) return 0;

  const minWeight = coldStartUser ? params.minCold : params.minWarm;
  const maxWeight = coldStartUser ? params.maxCold : params.maxWarm;
  const heuristicNeed = Math.pow(clamp(1 - heuristicEvidence, 0, 1), params.evidencePower);
  const targetWeight =
    minWeight + (maxWeight - minWeight) * heuristicNeed + explorationFactor * params.explorationLift;

  return clamp(
    targetWeight * clamp(mfConfidence, 0, 1),
    minWeight * params.minFloorMultiplier,
    maxWeight
  );
}

function evaluateHybridStrategy(
  rows: HybridEvalRow[],
  strategyName: string,
  mfConfidence: number,
  params?: AdaptiveBlendParams
): HybridStrategyResult | null {
  if (rows.length === 0) return null;

  let sse = 0;
  let sae = 0;
  let beatsMf = 0;
  let beatsHeur = 0;
  const weights: number[] = [];

  for (const row of rows) {
    const mfWeight = params
      ? computeAdaptiveMfWeightFromParams({
          mfConfidence,
          hasPrediction: row.hasMfPrediction,
          coldStartUser: row.coldStartUser,
          heuristicEvidence: row.heuristicEvidence,
          explorationFactor: row.explorationFactor,
          params,
        })
      : row.hasMfPrediction
        ? clamp(mfConfidence * 0.4, 0, 0.4)
        : 0;
    const hybridPred = row.heuristicPred * (1 - mfWeight) + row.mfPred * mfWeight;
    const hybridErr = Math.abs(row.actual - hybridPred);
    const mfErr = Math.abs(row.actual - row.mfPred);
    const heurErr = Math.abs(row.actual - row.heuristicPred);

    sse += hybridErr * hybridErr;
    sae += hybridErr;
    weights.push(mfWeight);

    if (hybridErr + 1e-9 < mfErr) beatsMf++;
    if (hybridErr + 1e-9 < heurErr) beatsHeur++;
  }

  return {
    strategy: strategyName,
    params,
    rmse: Math.sqrt(sse / rows.length),
    mae: sae / rows.length,
    mfWeightMean: average(weights),
    mfWeightP90: percentile(weights, 0.9),
    mfWeightMax: Math.max(...weights),
    hybridBeatsMfRate: beatsMf / rows.length,
    hybridBeatsHeuristicRate: beatsHeur / rows.length,
  };
}

function generateAdaptiveCandidateParams(): AdaptiveBlendParams[] {
  const minWarmValues = [0.02, 0.04, 0.07];
  const maxWarmValues = [0.45, 0.6, 0.75];
  const minColdValues = [0.12, 0.18, 0.25];
  const maxColdValues = [0.65, 0.75, 0.9];
  const explorationLiftValues = [0.06, 0.12, 0.18];
  const evidencePowerValues = [1.0, 1.25, 1.5];
  const minFloorMultiplierValues = [0.0, 0.25, 0.5];

  const candidates: AdaptiveBlendParams[] = [];
  for (const minWarm of minWarmValues) {
    for (const maxWarm of maxWarmValues) {
      if (maxWarm <= minWarm) continue;
      for (const minCold of minColdValues) {
        for (const maxCold of maxColdValues) {
          if (maxCold <= minCold) continue;
          for (const explorationLift of explorationLiftValues) {
            for (const evidencePower of evidencePowerValues) {
              for (const minFloorMultiplier of minFloorMultiplierValues) {
                candidates.push({
                  minWarm,
                  maxWarm,
                  minCold,
                  maxCold,
                  explorationLift,
                  evidencePower,
                  minFloorMultiplier,
                });
              }
            }
          }
        }
      }
    }
  }
  return candidates;
}

function fitLinearCalibration(points: Array<{ score: number; rating: number }>): {
  intercept: number;
  slope: number;
} {
  if (points.length === 0) {
    return { intercept: 3, slope: 0 };
  }
  if (points.length === 1) {
    return { intercept: points[0].rating, slope: 0 };
  }

  const meanX = average(points.map((p) => p.score));
  const meanY = average(points.map((p) => p.rating));

  let num = 0;
  let den = 0;
  for (const point of points) {
    const dx = point.score - meanX;
    num += dx * (point.rating - meanY);
    den += dx * dx;
  }

  if (den <= 1e-8) {
    return { intercept: meanY, slope: 0 };
  }

  const slope = num / den;
  const intercept = meanY - slope * meanX;
  return { intercept, slope };
}

export async function evaluateHeuristicVsMF(
  partial: Partial<HeuristicVsMFEvalConfig> = {}
): Promise<HeuristicVsMFEvalResult> {
  const startedAt = Date.now();
  const config: HeuristicVsMFEvalConfig = {
    validationSplitPercent: partial.validationSplitPercent ?? 20,
    minValidationRatingsPerUser: partial.minValidationRatingsPerUser ?? 5,
    maxUsers: partial.maxUsers ?? null,
    includePerUser: partial.includePerUser ?? false,
    tuneHybrid: partial.tuneHybrid ?? false,
  };

  const model = await getModelMetadata();
  if (!model) {
    return {
      model: null,
      config,
      usersConsidered: 0,
      usersEvaluated: 0,
      ratingRowsEvaluated: 0,
      metrics: {
        heuristicRmse: null,
        heuristicMae: null,
        mfRmse: null,
        mfMae: null,
        mfCoverage: null,
        mfBeatsHeuristicRate: null,
        heuristicBeatsMfRate: null,
        tieRate: null,
        hybridRmse: null,
        hybridMae: null,
        hybridBeatsMfRate: null,
        hybridBeatsHeuristicRate: null,
      },
      caveats: [
        "No MF model metadata found.",
      ],
      timingMs: Date.now() - startedAt,
    };
  }

  if (model.isTraining) {
    throw new Error("Model is currently training; try again after training completes.");
  }

  const [algorithmSettings, userRows] = await Promise.all([
    getAlgorithmSettings(),
    prisma.movieRating.findMany({
      where: { rating: { not: null }, notHeardOf: false },
      distinct: ["userId"],
      select: { userId: true },
    }),
  ]);

  const userIds = userRows.map((row) => row.userId).slice(0, config.maxUsers ?? userRows.length);

  let heurSse = 0;
  let heurSae = 0;
  let mfSse = 0;
  let mfSae = 0;
  let totalRows = 0;
  let mfCoveredRows = 0;
  let mfWins = 0;
  let heurWins = 0;
  let ties = 0;
  const perUser: HeuristicVsMFEvalUserResult[] = [];
  const hybridRows: HybridEvalRow[] = [];

  for (const userId of userIds) {
    const profile = await buildDiscoveryPreferenceProfile(userId);
    const coldStartUser = computeColdStartUser(profile);
    const effectiveExplorationFactor = computeEffectiveExplorationFactor(
      profile.explorationFactor,
      coldStartUser
    );

    const ratings = await prisma.movieRating.findMany({
      where: {
        userId,
        rating: { not: null },
        notHeardOf: false,
      },
      select: {
        movieId: true,
        rating: true,
        movie: {
          select: {
            id: true,
            tmdbId: true,
            isMlOnly: true,
            year: true,
            releaseDate: true,
            popularity: true,
            voteAverage: true,
            voteCount: true,
            imdbRating: true,
            letterboxdRating: true,
            mlRatingCount: true,
            genres: { select: { genreId: true } },
            cast: {
              select: { personId: true },
              orderBy: { castOrder: "asc" },
              take: 5,
            },
            crew: {
              where: { job: "Director" },
              select: { personId: true },
            },
            studios: { select: { studioId: true } },
            ratings: {
              where: {
                userId: { in: profile.householdUserIds },
                rating: { not: null },
                notHeardOf: false,
              },
              select: {
                userId: true,
                rating: true,
                hasSeen: true,
                notHeardOf: true,
              },
            },
            plexAvailability: { select: { available: true } },
            radarrSync: { select: { available: true } },
          },
        },
      },
    });

    const training = ratings.filter(
      (row) => !isInValidationSplit(userId, row.movieId, config.validationSplitPercent)
    );
    const validation = ratings.filter((row) =>
      isInValidationSplit(userId, row.movieId, config.validationSplitPercent)
    );

    if (validation.length < config.minValidationRatingsPerUser || training.length < 2) {
      continue;
    }

    const calibrationPoints = training.map((row) => {
      const rawScore = computeHeuristicRawScore(
        row.movie as EvalMovie,
        userId,
        profile,
        algorithmSettings.movieDiscovery,
        true
      );
      return {
        score: rawScore,
        rating: row.rating as number,
      };
    });
    const { intercept, slope } = fitLinearCalibration(calibrationPoints);

    const validationMovieIds = validation.map((row) => row.movieId);
    const mfPredictions = await getPredictedRatingsForUser(userId, validationMovieIds);

    let userHeurSse = 0;
    let userHeurSae = 0;
    let userMfSse = 0;
    let userMfSae = 0;
    let userMfCovered = 0;

    for (const row of validation) {
      const actual = row.rating as number;
      const rawHeuristic = computeHeuristicRawScore(
        row.movie as EvalMovie,
        userId,
        profile,
        algorithmSettings.movieDiscovery,
        true
      );
      const heuristicPred = clamp(intercept + slope * rawHeuristic, 1, 5);

      const mfRaw = mfPredictions.get(row.movieId);
      const mfPred = clamp(mfRaw ?? 3, 1, 5);
      if (mfRaw !== undefined) userMfCovered++;

      const heurAbsErr = Math.abs(actual - heuristicPred);
      const mfAbsErr = Math.abs(actual - mfPred);
      const heurSqErr = heurAbsErr * heurAbsErr;
      const mfSqErr = mfAbsErr * mfAbsErr;

      userHeurSse += heurSqErr;
      userHeurSae += heurAbsErr;
      userMfSse += mfSqErr;
      userMfSae += mfAbsErr;

      hybridRows.push({
        actual,
        heuristicPred,
        mfPred,
        hasMfPrediction: mfRaw !== undefined,
        coldStartUser,
        explorationFactor: effectiveExplorationFactor,
        heuristicEvidence: computeHeuristicEvidence(row.movie as EvalMovie, userId, profile),
      });

      if (mfAbsErr + 1e-9 < heurAbsErr) mfWins++;
      else if (heurAbsErr + 1e-9 < mfAbsErr) heurWins++;
      else ties++;
    }

    const userCount = validation.length;
    heurSse += userHeurSse;
    heurSae += userHeurSae;
    mfSse += userMfSse;
    mfSae += userMfSae;
    totalRows += userCount;
    mfCoveredRows += userMfCovered;

    perUser.push({
      userId,
      trainingCount: training.length,
      validationCount: userCount,
      heuristicRmse: Math.sqrt(userHeurSse / userCount),
      heuristicMae: userHeurSae / userCount,
      mfRmse: Math.sqrt(userMfSse / userCount),
      mfMae: userMfSae / userCount,
      mfCoverage: userMfCovered / userCount,
    });
  }

  const pairwiseTotal = mfWins + heurWins + ties;
  const currentAdaptiveParams: AdaptiveBlendParams = {
    minWarm: 0.07,
    maxWarm: 0.75,
    minCold: 0.18,
    maxCold: 0.75,
    explorationLift: 0.18,
    evidencePower: 1,
    minFloorMultiplier: 0,
  };
  const currentAdaptive = evaluateHybridStrategy(
    hybridRows,
    "adaptive_current",
    model.confidence,
    currentAdaptiveParams
  );
  const fixed40 = evaluateHybridStrategy(hybridRows, "fixed_40_cap", model.confidence);

  const strategyCandidates: HybridStrategyResult[] = [];
  if (fixed40) strategyCandidates.push(fixed40);
  if (currentAdaptive) strategyCandidates.push(currentAdaptive);
  if (config.tuneHybrid) {
    for (const params of generateAdaptiveCandidateParams()) {
      const strategy = evaluateHybridStrategy(
        hybridRows,
        "adaptive_tuned",
        model.confidence,
        params
      );
      if (strategy) strategyCandidates.push(strategy);
    }
  }

  strategyCandidates.sort((a, b) => {
    if (a.rmse !== b.rmse) return a.rmse - b.rmse;
    return a.mae - b.mae;
  });

  const recommendedHybrid = strategyCandidates[0] ?? currentAdaptive ?? fixed40 ?? null;
  const activeHybrid = recommendedHybrid;
  const hybridBeatsMfRate = activeHybrid?.hybridBeatsMfRate ?? null;
  const hybridBeatsHeuristicRate = activeHybrid?.hybridBeatsHeuristicRate ?? null;

  return {
    model,
    config,
    usersConsidered: userIds.length,
    usersEvaluated: perUser.length,
    ratingRowsEvaluated: totalRows,
    metrics: {
      heuristicRmse: totalRows > 0 ? Math.sqrt(heurSse / totalRows) : null,
      heuristicMae: totalRows > 0 ? heurSae / totalRows : null,
      mfRmse: totalRows > 0 ? Math.sqrt(mfSse / totalRows) : null,
      mfMae: totalRows > 0 ? mfSae / totalRows : null,
      mfCoverage: totalRows > 0 ? mfCoveredRows / totalRows : null,
      mfBeatsHeuristicRate: pairwiseTotal > 0 ? mfWins / pairwiseTotal : null,
      heuristicBeatsMfRate: pairwiseTotal > 0 ? heurWins / pairwiseTotal : null,
      tieRate: pairwiseTotal > 0 ? ties / pairwiseTotal : null,
      hybridRmse: activeHybrid?.rmse ?? null,
      hybridMae: activeHybrid?.mae ?? null,
      hybridBeatsMfRate,
      hybridBeatsHeuristicRate,
    },
    hybridStrategy: activeHybrid
      ? {
          strategy: activeHybrid.strategy,
          params: activeHybrid.params,
          mfWeightMean: activeHybrid.mfWeightMean,
          mfWeightP90: activeHybrid.mfWeightP90,
          mfWeightMax: activeHybrid.mfWeightMax,
        }
      : undefined,
    tuning: config.tuneHybrid && strategyCandidates.length > 0
      ? {
          objective: "rmse_then_mae",
          strategiesSearched: strategyCandidates.length,
          recommended: strategyCandidates[0],
          topStrategies: strategyCandidates.slice(0, 8),
        }
      : undefined,
    caveats: [
      "Deterministic holdout split by hash(userId,movieId) is used for comparability.",
      "Heuristic scores are linearly calibrated per user on that user's training subset before evaluating holdout rows.",
      "MF model is the currently saved model and may already include some holdout interactions from prior training runs, so this is not a full retrain-per-split benchmark.",
      "Heuristic evaluation disables direct self-rating leakage signals for the target movie (movie-specific affinity and self household vote).",
      "Hybrid tuning (when enabled) optimizes RMSE first with MAE as tie-break on this holdout split.",
    ],
    perUser: config.includePerUser ? perUser : undefined,
    timingMs: Date.now() - startedAt,
  };
}
