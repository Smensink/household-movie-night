import { prisma } from "@/lib/prisma";
import { getModelMetadata, getPredictedRatingsForUser } from "@/lib/matrix-factorization";

type EvalUserResult = {
  userId: string;
  validationRatedCount: number;
  validationPositiveCount: number;
  candidateCount: number;
  ndcgAtK: number;
  mapAtK: number;
  auc: number | null;
  hitRateAtK: number;
};

export type MFEvalConfig = {
  // Deterministic holdout split by (userId,movieId) hash.
  validationSplitPercent: number; // default 10

  // Ranking evaluation.
  k: number; // default 10
  negativesPerUser: number; // default 200
  maxValidationRatedPerUser: number; // default 50
  minValidationPositivesPerUser: number; // default 3

  // Define positives from explicit ratings.
  positiveRatingThreshold: number; // default 4
  // For NDCG relevance: 5 -> 2, 4 -> 1, else 0.

  // Safety / perf.
  maxUsers: number | null; // default null (no cap)
  includePerUser: boolean; // default false
};

export type MFEvalResult = {
  model: Awaited<ReturnType<typeof getModelMetadata>>;
  config: MFEvalConfig;
  usersConsidered: number;
  usersEvaluated: number;
  metrics: {
    ndcgAtK: number | null;
    mapAtK: number | null;
    auc: number | null;
    hitRateAtK: number | null;
  };
  perUser?: EvalUserResult[];
  timingMs: number;
};

function fnv1a32(input: string): number {
  // Deterministic non-crypto hash for splitting.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // h *= 16777619 (use bit ops to stay in uint32)
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h >>> 0;
}

function isInValidationSplit(userId: string, movieId: string, pct: number): boolean {
  const p = Math.max(1, Math.min(99, Math.floor(pct)));
  return fnv1a32(`${userId}:${movieId}`) % 100 < p;
}

function log2(x: number): number {
  return Math.log(x) / Math.log(2);
}

function ndcgAtK(items: { score: number; relevance: number }[], k: number): number | null {
  const K = Math.max(1, Math.floor(k));
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const dcg = sorted.slice(0, K).reduce((sum, it, idx) => {
    if (it.relevance <= 0) return sum;
    // gains: 2^rel - 1
    const gain = Math.pow(2, it.relevance) - 1;
    return sum + gain / log2(idx + 2);
  }, 0);

  const ideal = [...items].sort((a, b) => b.relevance - a.relevance);
  const idcg = ideal.slice(0, K).reduce((sum, it, idx) => {
    if (it.relevance <= 0) return sum;
    const gain = Math.pow(2, it.relevance) - 1;
    return sum + gain / log2(idx + 2);
  }, 0);

  if (idcg <= 0) return null;
  return dcg / idcg;
}

function mapAtK(items: { score: number; isPositive: boolean }[], k: number): number | null {
  const K = Math.max(1, Math.floor(k));
  const sorted = [...items].sort((a, b) => b.score - a.score).slice(0, K);
  const totalPos = sorted.filter((i) => i.isPositive).length;
  if (totalPos === 0) return null;
  let hits = 0;
  let sumPrec = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].isPositive) {
      hits++;
      sumPrec += hits / (i + 1);
    }
  }
  return sumPrec / totalPos;
}

function aucPairwise(posScores: number[], negScores: number[]): number | null {
  if (posScores.length === 0 || negScores.length === 0) return null;
  let better = 0;
  let ties = 0;
  let total = 0;
  for (const p of posScores) {
    for (const n of negScores) {
      total++;
      if (p > n) better++;
      else if (p === n) ties++;
    }
  }
  if (total === 0) return null;
  return (better + 0.5 * ties) / total;
}

function pickNegatives(
  allMovieIds: string[],
  exclude: Set<string>,
  n: number,
  seedKey: string
): string[] {
  const want = Math.max(0, Math.floor(n));
  if (want === 0) return [];
  const res: string[] = [];

  // Deterministic pseudo-random walk over indices.
  let state = fnv1a32(seedKey) || 1;
  const len = allMovieIds.length;
  let guard = 0;
  while (res.length < want && guard < want * 50 && len > 0) {
    // LCG
    state = (1664525 * state + 1013904223) >>> 0;
    const idx = state % len;
    const id = allMovieIds[idx];
    if (!exclude.has(id)) {
      exclude.add(id);
      res.push(id);
    }
    guard++;
  }
  return res;
}

export async function evaluateMatrixFactorizationModel(
  partial: Partial<MFEvalConfig> = {}
): Promise<MFEvalResult> {
  const startedAt = Date.now();

  const config: MFEvalConfig = {
    validationSplitPercent: partial.validationSplitPercent ?? 10,
    k: partial.k ?? 10,
    negativesPerUser: partial.negativesPerUser ?? 200,
    maxValidationRatedPerUser: partial.maxValidationRatedPerUser ?? 50,
    minValidationPositivesPerUser: partial.minValidationPositivesPerUser ?? 3,
    positiveRatingThreshold: partial.positiveRatingThreshold ?? 4,
    maxUsers: partial.maxUsers ?? null,
    includePerUser: partial.includePerUser ?? false,
  };

  const model = await getModelMetadata();
  if (!model) {
    return {
      model: null,
      config,
      usersConsidered: 0,
      usersEvaluated: 0,
      metrics: { ndcgAtK: null, mapAtK: null, auc: null, hitRateAtK: null },
      timingMs: Date.now() - startedAt,
    };
  }

  if (model.isTraining) {
    throw new Error("Model is currently training; try again after training completes.");
  }

  // Candidate universe for negatives
  const allMovieIds = (await prisma.movie.findMany({ select: { id: true } })).map((m) => m.id);

  // Distinct users who have explicit ratings (household only; excludes ML community).
  const userRows = await prisma.movieRating.findMany({
    where: { rating: { not: null }, notHeardOf: false },
    distinct: ["userId"],
    select: { userId: true },
  });

  const userIds = userRows.map((u) => u.userId).slice(0, config.maxUsers ?? userRows.length);

  const perUser: EvalUserResult[] = [];

  let sumNdcg = 0;
  let cntNdcg = 0;
  let sumMap = 0;
  let cntMap = 0;
  let sumAuc = 0;
  let cntAuc = 0;
  let sumHit = 0;
  let cntHit = 0;

  for (const userId of userIds) {
    const ratings = await prisma.movieRating.findMany({
      where: { userId, rating: { not: null }, notHeardOf: false },
      select: { movieId: true, rating: true },
    });
    const ratedSet = new Set<string>(ratings.map((r) => r.movieId));

    // Deterministic validation split
    const validation = ratings.filter((r) =>
      isInValidationSplit(userId, r.movieId, config.validationSplitPercent)
    );

    // Positives are from held-out explicit ratings
    const pos = validation.filter((r) => (r.rating ?? 0) >= config.positiveRatingThreshold);
    if (pos.length < config.minValidationPositivesPerUser) continue;

    // Cap validation-rated items for perf but always keep all positives.
    const maxVal = Math.max(config.maxValidationRatedPerUser, pos.length);
    const nonPos = validation.filter((r) => (r.rating ?? 0) < config.positiveRatingThreshold);
    const capNonPos = Math.max(0, maxVal - pos.length);
    const nonPosSample = nonPos
      .sort((a, b) => fnv1a32(`${userId}:${a.movieId}`) - fnv1a32(`${userId}:${b.movieId}`))
      .slice(0, capNonPos);

    const validationUsed = [...pos, ...nonPosSample];

    const candidateMovieIds = new Set<string>(validationUsed.map((r) => r.movieId));

    // Add negatives (unrated) for ranking evaluation.
    const excludeForNegatives = new Set<string>([...ratedSet, ...candidateMovieIds]);
    const negs = pickNegatives(
      allMovieIds,
      excludeForNegatives,
      config.negativesPerUser,
      `neg:${userId}:${config.k}:${config.negativesPerUser}`
    );
    for (const id of negs) candidateMovieIds.add(id);

    const candidates = [...candidateMovieIds];
    if (candidates.length === 0) continue;

    // Get predicted scores
    const preds = await getPredictedRatingsForUser(userId, candidates);

    // Build per-candidate items
    const relMap = new Map<string, number>();
    for (const r of validationUsed) {
      const rating = r.rating ?? 0;
      // 5 -> 2, 4 -> 1, else 0
      const relevance = rating >= 5 ? 2 : rating >= config.positiveRatingThreshold ? 1 : 0;
      relMap.set(r.movieId, relevance);
    }

    const scored = candidates
      .map((movieId) => ({
        movieId,
        score: preds.get(movieId) ?? 3.0,
        relevance: relMap.get(movieId) ?? 0,
      }))
      .filter((x) => Number.isFinite(x.score));

    const ndcg = ndcgAtK(scored, config.k);
    if (ndcg != null) {
      sumNdcg += ndcg;
      cntNdcg++;
    }

    const map = mapAtK(
      scored.map((s) => ({ score: s.score, isPositive: s.relevance > 0 })),
      config.k
    );
    if (map != null) {
      sumMap += map;
      cntMap++;
    }

    const topK = [...scored].sort((a, b) => b.score - a.score).slice(0, config.k);
    const hit = topK.some((s) => s.relevance > 0) ? 1 : 0;
    sumHit += hit;
    cntHit++;

    // AUC over positives vs (unrated) negatives
    const posScores = scored.filter((s) => s.relevance > 0).map((s) => s.score);
    const negScores = scored
      .filter((s) => s.relevance === 0 && !ratedSet.has(s.movieId))
      .map((s) => s.score);

    const auc = aucPairwise(posScores, negScores);
    if (auc != null) {
      sumAuc += auc;
      cntAuc++;
    }

    if (config.includePerUser) {
      perUser.push({
        userId,
        validationRatedCount: validation.length,
        validationPositiveCount: pos.length,
        candidateCount: candidates.length,
        ndcgAtK: ndcg ?? 0,
        mapAtK: map ?? 0,
        auc,
        hitRateAtK: hit,
      });
    }
  }

  const result: MFEvalResult = {
    model,
    config,
    usersConsidered: userIds.length,
    usersEvaluated: cntHit,
    metrics: {
      ndcgAtK: cntNdcg > 0 ? sumNdcg / cntNdcg : null,
      mapAtK: cntMap > 0 ? sumMap / cntMap : null,
      auc: cntAuc > 0 ? sumAuc / cntAuc : null,
      hitRateAtK: cntHit > 0 ? sumHit / cntHit : null,
    },
    ...(config.includePerUser ? { perUser } : {}),
    timingMs: Date.now() - startedAt,
  };

  return result;
}
