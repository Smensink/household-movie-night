import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getModelMetadata } from "@/lib/matrix-factorization";

interface AffinityItem {
  id: string;
  name: string;
  affinity: number; // -1 to 1 scale
  ratingCount: number;
}

interface ArchetypeMovieExample {
  id: string;
  title: string;
  year: number | null;
  posterUrl: string | null;
  uniqueness: number; // margin vs other archetypes (cosine similarity)
  similarity: number; // cosine similarity
}

interface ProfileStats {
  user: {
    id: string;
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
  moviePersonality: {
    archetypeName: string;
    description: string;
    traits: string[];
    disposition: string;
    dispositionLabel: string;
    dispositionExplanation: string;
    topGenres: { name: string; score: number }[];
    archetypeSimilarities?: { name: string; score: number }[];
    archetypeLovedMovies?: ArchetypeMovieExample[];
    archetypeHatedMovies?: ArchetypeMovieExample[];
    archetypeSignature?: {
      yearRange?: { min: number | null; max: number | null; median: number | null };
      decades?: string[];
      eras?: string[];
      tags?: string[];
      directors?: string[];
      actors?: string[];
      studios?: string[];
    };
    ratingMean: number | null;
    ratingStdDev: number | null;
  } | null;
}

function normalizeRating(rating: number): number {
  return (rating - 3) / 2; // Convert 1-5 to -1 to 1
}

function parseVector(json: string, expectedDims?: number): number[] | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return null;
    const vec: number[] = [];
    for (const v of parsed) {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n)) return null;
      vec.push(n);
    }
    if (expectedDims != null && vec.length !== expectedDims) return null;
    return vec;
  } catch {
    return null;
  }
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

function norm(a: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s);
}

function normalizeUnit(a: number[]): number[] | null {
  const n = norm(a);
  if (!Number.isFinite(n) || n <= 0) return null;
  return a.map((v) => v / n);
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function topKeys(map: Map<string, number>, limit: number): string[] {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => k);
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

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const viewerUserId = session.user.id;
  const requestedUserId = req.nextUrl.searchParams.get("userId")?.trim();
  const userId = requestedUserId || viewerUserId;

  if (userId !== viewerUserId) {
    const sharedHousehold = await prisma.householdMember.findFirst({
      where: {
        userId: viewerUserId,
        household: {
          members: {
            some: { userId },
          },
        },
      },
      select: { id: true },
    });

    if (!sharedHousehold) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // Fetch all user data in parallel
  const [
    user,
    settings,
    totalGenres,
    genreRankings,
    movieRatings,
    actorRatings,
    directorRatings,
    studioRatings,
  ] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true },
    }),
    prisma.userSettings.findUnique({
      where: { userId },
      select: { explorationFactor: true, discoverySourcePref: true, minVoteCount: true },
    }),
    prisma.genre.count(),
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
  const maxRank = Math.max(totalGenres, 1);
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

  // Get movie personality (archetype + disposition)
  const userFeatureCache = await prisma.userFeatureCache.findUnique({
    where: { userId },
    include: { archetype: true },
  });

  const dispositionMap: Record<string, { label: string; explanation: string }> = {
    insufficient: { label: "Not Enough Data", explanation: "Rate more movies to discover your rating style" },
    balanced_wide: { label: "Fair & Opinionated", explanation: "You use the full rating scale around a balanced center" },
    balanced_narrow: { label: "Steady & Consistent", explanation: "You rate most movies similarly near the middle" },
    lenient_wide: { label: "Generous & Discerning", explanation: "You rate generously overall but strongly differentiate between films" },
    lenient_narrow: { label: "Generous & Consistent", explanation: "You tend to rate everything positively" },
    harsh_wide: { label: "Critical & Passionate", explanation: "You're tough to please but love what you love" },
    harsh_narrow: { label: "Exacting Standards", explanation: "You hold movies to a consistently high bar" },
  };

  let moviePersonality: ProfileStats["moviePersonality"] = null;
  if (userFeatureCache?.archetype) {
    const arch = userFeatureCache.archetype;
    const disp = userFeatureCache.ratingDisposition || "insufficient";
    const dispInfo = dispositionMap[disp] || dispositionMap.insufficient;

    // Optional soft distribution over archetypes (top 3) for more differentiation.
    let archetypeSimilarities: { name: string; score: number }[] | undefined = undefined;
    if (userFeatureCache.archetypeScores) {
      try {
        const parsed = JSON.parse(userFeatureCache.archetypeScores) as Record<string, number>;
        const ids = Object.keys(parsed || {});
        if (ids.length > 0) {
          const archetypes = await prisma.viewerArchetype.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true },
          });
          const nameById = new Map(archetypes.map((a) => [a.id, a.name]));
          archetypeSimilarities = ids
            .map((id) => ({ name: nameById.get(id) || "Unknown", score: Number(parsed[id]) || 0 }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 3);
        }
      } catch {
        // ignore parse errors
      }
    }

    moviePersonality = {
      archetypeName: arch.name,
      description: arch.description,
      traits: JSON.parse(arch.traits),
      disposition: disp,
      dispositionLabel: dispInfo.label,
      dispositionExplanation: dispInfo.explanation,
      topGenres: JSON.parse(arch.topGenres),
      archetypeSimilarities,
      ratingMean: userFeatureCache.ratingMean,
      ratingStdDev: userFeatureCache.ratingStdDev,
    };

    // Provide concrete movie examples that are "uniquely" high/low for this archetype.
    // This is based on archetype centroid similarity to movie latent vectors (cosine similarity),
    // and the margin versus other archetypes.
    try {
      const archetypes = await prisma.viewerArchetype.findMany({
        select: { id: true, centroid: true },
      });

      const target = archetypes.find((a) => a.id === arch.id);
      if (target && archetypes.length >= 2) {
        const targetVec = parseVector(target.centroid);
        if (targetVec) {
          const dims = targetVec.length;
          const targetUnit = normalizeUnit(targetVec);
          const otherUnits = archetypes
            .filter((a) => a.id !== arch.id)
            .map((a) => {
              const v = parseVector(a.centroid, dims);
              const u = v ? normalizeUnit(v) : null;
              return u ? { id: a.id, unit: u } : null;
            })
            .filter(Boolean) as Array<{ id: string; unit: number[] }>;

          if (targetUnit && otherUnits.length > 0) {
            const minVoteCount = Math.max(0, Math.floor(settings?.minVoteCount ?? 500));
            const candidates = await prisma.movie.findMany({
              where: {
                posterUrl: { not: null },
                OR: [
                  { voteCount: { gte: minVoteCount } },
                  { imdbVotes: { gte: Math.max(1000, minVoteCount * 2) } },
                  { mlRatingCount: { gte: 500 } },
                ],
              },
              select: { id: true, title: true, year: true, posterUrl: true },
              orderBy: [{ voteCount: "desc" }, { imdbVotes: "desc" }, { updatedAt: "desc" }],
              take: 2000,
            });

            const ids = candidates.map((m) => m.id);
            const vectors = await prisma.latentVector.findMany({
              where: { entityType: "movie", entityId: { in: ids } },
              select: { entityId: true, vector: true },
            });
            const vecById = new Map(vectors.map((v) => [v.entityId, v.vector]));

            const loved: ArchetypeMovieExample[] = [];
            const hated: ArchetypeMovieExample[] = [];

            for (const m of candidates) {
              const raw = vecById.get(m.id);
              if (!raw) continue;
              const mv = parseVector(raw, dims);
              if (!mv) continue;
              const mvUnit = normalizeUnit(mv);
              if (!mvUnit) continue;

              const tSim = dot(targetUnit, mvUnit);
              let maxOther = -Infinity;
              let minOther = Infinity;
              for (const o of otherUnits) {
                const s = dot(o.unit, mvUnit);
                if (s > maxOther) maxOther = s;
                if (s < minOther) minOther = s;
              }

              const loveMargin = tSim - maxOther;
              const hateMargin = minOther - tSim;

              // Avoid noisy picks: require both margin and absolute position.
              if (Number.isFinite(loveMargin) && loveMargin > 0.06 && tSim > 0.08) {
                loved.push({
                  id: m.id,
                  title: m.title,
                  year: m.year ?? null,
                  posterUrl: m.posterUrl ?? null,
                  uniqueness: loveMargin,
                  similarity: tSim,
                });
              }
              if (Number.isFinite(hateMargin) && hateMargin > 0.06 && tSim < 0.02) {
                hated.push({
                  id: m.id,
                  title: m.title,
                  year: m.year ?? null,
                  posterUrl: m.posterUrl ?? null,
                  uniqueness: hateMargin,
                  similarity: tSim,
                });
              }
            }

            loved.sort((a, b) => b.uniqueness - a.uniqueness);
            hated.sort((a, b) => b.uniqueness - a.uniqueness);

            moviePersonality.archetypeLovedMovies = loved.slice(0, 10);
            moviePersonality.archetypeHatedMovies = hated.slice(0, 10);

            // Build a compact signature from the top uniquely-loved examples.
            const lovedIds = moviePersonality.archetypeLovedMovies.map((m) => m.id);
            if (lovedIds.length > 0) {
              const sigMovies = await prisma.movie.findMany({
                where: { id: { in: lovedIds } },
                select: {
                  id: true,
                  year: true,
                  era: true,
                  cast: {
                    select: { person: { select: { name: true } } },
                    take: 5,
                    orderBy: { castOrder: "asc" },
                  },
                  crew: {
                    where: { job: "Director" },
                    select: { person: { select: { name: true } } },
                    take: 3,
                  },
                  studios: {
                    select: { studio: { select: { name: true } } },
                    take: 3,
                  },
                  movieTags: {
                    select: { tag: true, relevance: true },
                    orderBy: { relevance: "desc" },
                    take: 8,
                  },
                },
              });

              const years: number[] = [];
              const decadeCounts = new Map<string, number>();
              const eraCounts = new Map<string, number>();
              const tagScores = new Map<string, number>();
              const directorCounts = new Map<string, number>();
              const actorCounts = new Map<string, number>();
              const studioCounts = new Map<string, number>();

              for (const m of sigMovies) {
                if (m.year != null) {
                  years.push(m.year);
                  const decade = `${Math.floor(m.year / 10) * 10}s`;
                  decadeCounts.set(decade, (decadeCounts.get(decade) || 0) + 1);
                }
                if (m.era) {
                  eraCounts.set(m.era, (eraCounts.get(m.era) || 0) + 1);
                }
                for (const t of m.movieTags) {
                  const w = Number.isFinite(t.relevance) ? t.relevance : 0;
                  tagScores.set(t.tag, (tagScores.get(t.tag) || 0) + Math.max(0.1, w));
                }
                for (const d of m.crew) {
                  const name = d.person?.name?.trim();
                  if (!name) continue;
                  directorCounts.set(name, (directorCounts.get(name) || 0) + 1);
                }
                for (const c of m.cast) {
                  const name = c.person?.name?.trim();
                  if (!name) continue;
                  actorCounts.set(name, (actorCounts.get(name) || 0) + 1);
                }
                for (const s of m.studios) {
                  const name = s.studio?.name?.trim();
                  if (!name) continue;
                  studioCounts.set(name, (studioCounts.get(name) || 0) + 1);
                }
              }

              moviePersonality.archetypeSignature = {
                yearRange: years.length
                  ? {
                      min: Math.min(...years),
                      max: Math.max(...years),
                      median: median(years),
                    }
                  : { min: null, max: null, median: null },
                decades: topKeys(decadeCounts, 5),
                eras: topKeys(eraCounts, 3),
                tags: topKeys(tagScores, 10),
                directors: topKeys(directorCounts, 6),
                actors: topKeys(actorCounts, 8),
                studios: topKeys(studioCounts, 6),
              };
            }
          }
        }
      }
    } catch {
      // Best-effort: profile should still render even if archetype examples fail.
    }
  }

  const stats: ProfileStats = {
    user: {
      id: user?.id || userId,
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
    moviePersonality,
  };

  return NextResponse.json(stats);
}



