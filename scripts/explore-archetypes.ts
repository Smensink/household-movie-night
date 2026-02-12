import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

function createPrismaClient() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
  });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

const prisma = createPrismaClient();

function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

type TopMovie = {
  movieId: string;
  title: string;
  year: number | null;
  runtime: number | null;
  score: number;
  imdbRating: number | null;
  voteCount: number | null;
  genres: string[];
  directors: string[];
  studios: string[];
  tags: string[];
  originalLanguage: string | null;
  era: string | null;
};

function topEntries(map: Map<string, number>, n: number): Array<{ key: string; value: number }> {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, value]) => ({ key, value }));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function decadeLabel(year: number): string {
  const d = Math.floor(year / 10) * 10;
  return `${d}s`;
}

function summarizeMovies(movies: TopMovie[]) {
  const genreCounts = new Map<string, number>();
  const directorCounts = new Map<string, number>();
  const studioCounts = new Map<string, number>();
  const tagScores = new Map<string, number>();
  const eraCounts = new Map<string, number>();
  const langCounts = new Map<string, number>();
  const decadeCounts = new Map<string, number>();

  const runtimes: number[] = [];
  const years: number[] = [];
  const imdbRatings: number[] = [];
  const voteCounts: number[] = [];

  for (const m of movies) {
    for (const g of m.genres) genreCounts.set(g, (genreCounts.get(g) || 0) + 1);
    for (const d of m.directors) directorCounts.set(d, (directorCounts.get(d) || 0) + 1);
    for (const s of m.studios) studioCounts.set(s, (studioCounts.get(s) || 0) + 1);
    for (const t of m.tags) tagScores.set(t, (tagScores.get(t) || 0) + 1);
    if (m.era) eraCounts.set(m.era, (eraCounts.get(m.era) || 0) + 1);
    if (m.originalLanguage) langCounts.set(m.originalLanguage, (langCounts.get(m.originalLanguage) || 0) + 1);
    if (m.runtime != null) runtimes.push(m.runtime);
    if (m.year != null) {
      years.push(m.year);
      decadeCounts.set(decadeLabel(m.year), (decadeCounts.get(decadeLabel(m.year)) || 0) + 1);
    }
    if (m.imdbRating != null) imdbRatings.push(m.imdbRating);
    if (m.voteCount != null) voteCounts.push(m.voteCount);
  }

  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  return {
    topGenres: topEntries(genreCounts, 6),
    topDirectors: topEntries(directorCounts, 5),
    topStudios: topEntries(studioCounts, 5),
    topTags: topEntries(tagScores, 8),
    topEras: topEntries(eraCounts, 3),
    topLangs: topEntries(langCounts, 3),
    topDecades: topEntries(decadeCounts, 5),
    runtimeAvg: avg(runtimes),
    runtimeMedian: median(runtimes),
    yearMin: years.length ? Math.min(...years) : null,
    yearMax: years.length ? Math.max(...years) : null,
    yearMedian: median(years),
    imdbAvg: avg(imdbRatings),
    voteCountAvg: avg(voteCounts),
  };
}

async function main() {
  const metadata = await prisma.mFModelMetadata.findFirst({
    select: { globalMean: true },
  });
  const globalMean = metadata?.globalMean ?? 0;

  const archetypes = await prisma.viewerArchetype.findMany({
    orderBy: { clusterSize: "desc" },
  });

  if (archetypes.length === 0) {
    console.log("No archetypes found. Train the model with ML ratings first.");
    return;
  }

  // Use a reasonably sized, recognizable movie universe for qualitative descriptions.
  // Keep it stable and not too large so this script is safe to run on the server.
  const candidateMovies = await prisma.movie.findMany({
    where: {
      isMlOnly: false,
      posterUrl: { not: null },
      OR: [{ voteCount: { gte: 500 } }, { imdbRating: { gte: 7.0 } }],
    },
    orderBy: [{ popularity: "desc" }, { voteAverage: "desc" }],
    take: 5000,
    select: {
      id: true,
      title: true,
      year: true,
      runtime: true,
      originalLanguage: true,
      era: true,
      imdbRating: true,
      voteCount: true,
      genres: { select: { genre: { select: { name: true } } } },
      crew: {
        where: { job: "Director" },
        select: { person: { select: { name: true } } },
        take: 2,
      },
      studios: { select: { studio: { select: { name: true } } }, take: 2 },
      movieTags: { select: { tag: true, relevance: true }, orderBy: { relevance: "desc" }, take: 6 },
    },
  });
  const candidateIds = candidateMovies.map((m) => m.id);

  // Load movie latent vectors in chunks.
  const movieVectors = new Map<string, { vec: number[]; bias: number }>();
  const CHUNK = 800;
  for (let i = 0; i < candidateIds.length; i += CHUNK) {
    const ids = candidateIds.slice(i, i + CHUNK);
    const rows = await prisma.latentVector.findMany({
      where: { entityType: "movie", entityId: { in: ids } },
      select: { entityId: true, vector: true, bias: true },
    });
    for (const r of rows) {
      const vec = safeJsonParse<number[]>(r.vector, []);
      if (vec.length > 0) {
        movieVectors.set(r.entityId, { vec, bias: r.bias });
      }
    }
  }

  const movieById = new Map(
    candidateMovies.map((m) => [
      m.id,
      {
        title: m.title,
        year: m.year ?? null,
        runtime: m.runtime ?? null,
        originalLanguage: m.originalLanguage ?? null,
        era: m.era ?? null,
        imdbRating: m.imdbRating ?? null,
        voteCount: m.voteCount ?? null,
        genres: (m.genres || []).map((g) => g.genre.name).filter(Boolean).slice(0, 3),
        directors: (m.crew || []).map((c) => c.person.name).filter(Boolean).slice(0, 2),
        studios: (m.studios || []).map((s) => s.studio.name).filter(Boolean).slice(0, 2),
        tags: (m.movieTags || []).map((t) => t.tag).filter(Boolean).slice(0, 4),
      },
    ])
  );

  console.log(`Found ${archetypes.length} archetypes. Movie candidates: ${candidateMovies.length}, with vectors: ${movieVectors.size}`);
  console.log("");

  for (const a of archetypes) {
    const centroid = safeJsonParse<number[]>(a.centroid, []);
    const topGenres = safeJsonParse<Array<{ name: string; score: number }>>(a.topGenres, []);
    const traits = safeJsonParse<string[]>(a.traits, []);

    const top: TopMovie[] = [];
    const bottom: TopMovie[] = [];

    for (const [movieId, mv] of movieVectors.entries()) {
      const meta = movieById.get(movieId);
      if (!meta) continue;
      const score = globalMean + mv.bias + dot(centroid, mv.vec);
      const item: TopMovie = {
        movieId,
        title: meta.title,
        year: meta.year,
        runtime: meta.runtime,
        score,
        imdbRating: meta.imdbRating,
        voteCount: meta.voteCount,
        genres: meta.genres,
        directors: meta.directors,
        studios: meta.studios,
        tags: meta.tags,
        originalLanguage: meta.originalLanguage,
        era: meta.era,
      };

      // maintain top-10
      if (top.length < 10) {
        top.push(item);
        top.sort((x, y) => y.score - x.score);
      } else if (item.score > top[top.length - 1].score) {
        top[top.length - 1] = item;
        top.sort((x, y) => y.score - x.score);
      }

      // maintain bottom-5
      if (bottom.length < 5) {
        bottom.push(item);
        bottom.sort((x, y) => x.score - y.score);
      } else if (item.score < bottom[bottom.length - 1].score) {
        bottom[bottom.length - 1] = item;
        bottom.sort((x, y) => x.score - y.score);
      }
    }

    console.log("=".repeat(80));
    console.log(`${a.name} (size=${a.clusterSize})`);
    console.log(a.description);
    if (topGenres.length > 0) {
      console.log(`Distinctive genres: ${topGenres.slice(0, 5).map((g) => g.name).join(", ")}`);
    }
    if (traits.length > 0) {
      console.log(`Traits: ${traits.slice(0, 4).join(" | ")}`);
    }
    console.log("");

    console.log("Top movies (by centroid score):");
    for (const m of top) {
      console.log(
        `- ${m.title}${m.year ? ` (${m.year})` : ""} score=${m.score.toFixed(2)} ` +
          `genres=${m.genres.join("/") || "?"} ` +
          `dir=${m.directors.join(", ") || "?"} ` +
          `rt=${m.runtime ?? "?"}m ` +
          `studio=${m.studios.join(", ") || "?"} ` +
          `tags=${m.tags.join(", ") || "?"} ` +
          `imdb=${m.imdbRating ?? "?"} votes=${m.voteCount ?? "?"}`
      );
    }
    console.log("");

    // Summarize what this archetype "looks like" based on its top-scoring movies.
    const signature = summarizeMovies(top.slice(0, 10));
    console.log("Signature (from top movies):");
    if (signature.yearMin != null && signature.yearMax != null) {
      console.log(
        `- Year: ${signature.yearMin}..${signature.yearMax} (median ${signature.yearMedian ?? "?"})`
      );
    }
    if (signature.runtimeAvg != null) {
      console.log(
        `- Runtime: avg ${signature.runtimeAvg.toFixed(0)}m (median ${signature.runtimeMedian?.toFixed(0) ?? "?"}m)`
      );
    }
    if (signature.imdbAvg != null) {
      console.log(`- IMDb: avg ${signature.imdbAvg.toFixed(1)} (votes avg ${signature.voteCountAvg?.toFixed(0) ?? "?"})`);
    }
    if (signature.topDecades.length > 0) {
      console.log(`- Decades: ${signature.topDecades.map((d) => d.key).join(", ")}`);
    }
    if (signature.topEras.length > 0) {
      console.log(`- Era: ${signature.topEras.map((e) => `${e.key}(${e.value})`).join(", ")}`);
    }
    if (signature.topLangs.length > 0) {
      console.log(`- Languages: ${signature.topLangs.map((l) => `${l.key}(${l.value})`).join(", ")}`);
    }
    if (signature.topDirectors.length > 0) {
      console.log(`- Recurring directors: ${signature.topDirectors.map((d) => `${d.key}(${d.value})`).join(", ")}`);
    }
    if (signature.topStudios.length > 0) {
      console.log(`- Recurring studios: ${signature.topStudios.map((s) => `${s.key}(${s.value})`).join(", ")}`);
    }
    if (signature.topTags.length > 0) {
      console.log(`- Common tags: ${signature.topTags.map((t) => `${t.key}(${t.value})`).join(", ")}`);
    }
    console.log("");

    console.log("Bottom movies (anti-preferences signal):");
    for (const m of bottom) {
      console.log(
        `- ${m.title}${m.year ? ` (${m.year})` : ""} score=${m.score.toFixed(2)} genres=${m.genres.join("/") || "?"}`
      );
    }
    console.log("");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
