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
  score: number;
  imdbRating: number | null;
  voteCount: number | null;
  genres: string[];
};

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
      imdbRating: true,
      voteCount: true,
      genres: { select: { genre: { select: { name: true } } } },
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
        imdbRating: m.imdbRating ?? null,
        voteCount: m.voteCount ?? null,
        genres: (m.genres || []).map((g) => g.genre.name).filter(Boolean).slice(0, 3),
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
        score,
        imdbRating: meta.imdbRating,
        voteCount: meta.voteCount,
        genres: meta.genres,
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
        `- ${m.title}${m.year ? ` (${m.year})` : ""} score=${m.score.toFixed(2)} genres=${m.genres.join("/") || "?"} imdb=${m.imdbRating ?? "?"} votes=${m.voteCount ?? "?"}`
      );
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
