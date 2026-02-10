import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isInternalOrAdmin } from "@/lib/internal-auth";
import { parse } from "csv-parse";
import { Readable } from "stream";

// ml-25m: genome-scores.csv + genome-tags.csv (1128 curated semantic tag scores per movie)
const ML_25M_URL = "https://files.grouplens.org/datasets/movielens/ml-25m.zip";
// ml-32m: tags.csv (user-applied tags), ratings.csv (32M individual ratings), links.csv
const ML_32M_URL = "https://files.grouplens.org/datasets/movielens/ml-32m.zip";
const MAX_TAGS_PER_MOVIE = 15;
const MIN_USER_TAG_COUNT = 3;
const GENOME_MIN_RELEVANCE = 0.5;
const BATCH_SIZE = 2000;

type ZipEntry = {
  path: string;
  buffer: () => Promise<Buffer>;
  stream: () => NodeJS.ReadableStream;
};
type ZipDirectory = { files: ZipEntry[] };

/**
 * POST /api/movielens/import
 * Import ALL MovieLens data cached by imdbId (no FK to Movie):
 * - MLTagData: genome scores from ml-25m + user-frequency from ml-32m for ALL movies
 * - MLRating: ALL 32M individual ratings by imdbId
 * - MovieTag: backfilled from MLTagData for existing local movies
 * - letterboxdRating: per-movie averages for existing local movies
 *
 * Uses streaming for large CSV files to avoid JS string length limits.
 *
 * Query params:
 * - force=true: reimport tags (clears MLTagData + MovieTag)
 * - forceRatings=true: reimport ratings (clears MLRating)
 */
export async function POST(req: NextRequest) {
  if (!(await isInternalOrAdmin(req))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const force = req.nextUrl.searchParams.get("force") === "true";
  const forceRatings = req.nextUrl.searchParams.get("forceRatings") === "true";

  const [existingMLTagDataCount, existingMLRatingCount] = await Promise.all([
    prisma.mLTagData.count(),
    prisma.mLRating.count(),
  ]);

  const skipTags = !force && existingMLTagDataCount > 1000;
  const skipRatings = !forceRatings && existingMLRatingCount > 1000;

  if (skipTags && skipRatings) {
    return NextResponse.json({
      message: "MovieLens data already imported (use ?force=true for tags, ?forceRatings=true for ratings)",
      existingMLTagData: existingMLTagDataCount,
      existingMLRatings: existingMLRatingCount,
      skipped: true,
    });
  }

  console.log(`[MovieLens Import] Starting import (force=${force}, forceRatings=${forceRatings})...`);

  try {
    // Step 1: Download datasets (only the ones we need)
    const needMl25m = !skipTags;
    const needMl32m = !skipTags || !skipRatings;

    console.log(`[MovieLens Import] Downloading: ${needMl25m ? "ml-25m.zip" : ""} ${needMl32m ? "ml-32m.zip" : ""}...`);
    const fetches: Promise<Response>[] = [];
    if (needMl25m) fetches.push(fetch(ML_25M_URL));
    if (needMl32m) fetches.push(fetch(ML_32M_URL));
    const responses = await Promise.all(fetches);
    for (const resp of responses) {
      if (!resp.ok) throw new Error(`Failed to download: ${resp.url} (${resp.status})`);
    }

    let d25m: ZipDirectory | null = null;
    let d32m: ZipDirectory | null = null;
    const unzipper = await import("unzipper");

    if (needMl25m && needMl32m) {
      const [buf25m, buf32m] = await Promise.all([
        responses[0].arrayBuffer().then((b) => Buffer.from(b)),
        responses[1].arrayBuffer().then((b) => Buffer.from(b)),
      ]);
      console.log(
        `[MovieLens Import] Downloaded ml-25m (${(buf25m.length / 1024 / 1024).toFixed(0)}MB) + ml-32m (${(buf32m.length / 1024 / 1024).toFixed(0)}MB)`
      );
      const [dir25m, dir32m] = await Promise.all([
        unzipper.Open.buffer(buf25m),
        unzipper.Open.buffer(buf32m),
      ]);
      d25m = dir25m as unknown as ZipDirectory;
      d32m = dir32m as unknown as ZipDirectory;
    } else if (needMl32m) {
      const buf32m = await responses[0].arrayBuffer().then((b) => Buffer.from(b));
      console.log(`[MovieLens Import] Downloaded ml-32m (${(buf32m.length / 1024 / 1024).toFixed(0)}MB)`);
      d32m = (await unzipper.Open.buffer(buf32m)) as unknown as ZipDirectory;
    }

    // Step 2: Parse links.csv from ml-32m to build mlMovieId → imdbId mapping
    const mlToImdb = new Map<string, string>();
    if (d32m) {
      console.log("[MovieLens Import] Parsing links.csv...");
      await parseCsvString(
        await getFileString(d32m, "links.csv"),
        (row: { movieId: string; imdbId: string }) => {
          if (row.imdbId) mlToImdb.set(row.movieId, `tt${row.imdbId.padStart(7, "0")}`);
        }
      );
      console.log(`[MovieLens Import] ${mlToImdb.size} ML movies with imdbId mapping`);
    }

    // ── Phase A: Tags → MLTagData (cached by imdbId) + MovieTag (for local movies) ──
    let mlTagDataStored = 0;
    let movieTagsBackfilled = 0;

    if (!skipTags) {
      // Clear existing data for reimport
      if (existingMLTagDataCount > 0 || (await prisma.movieTag.count()) > 0) {
        console.log("[MovieLens Import] Clearing existing tag data for reimport...");
        await Promise.all([
          prisma.mLTagData.deleteMany(),
          prisma.movieTag.deleteMany(),
        ]);
      }

      // Phase A1: Genome tags from ml-25m → MLTagData
      console.log("[MovieLens Import] Phase A1: Streaming genome scores from ml-25m → MLTagData...");
      const genomeTagNames = new Map<string, string>();
      await parseCsvString(
        await getFileString(d25m!, "genome-tags.csv"),
        (row: { tagId: string; tag: string }) => {
          genomeTagNames.set(row.tagId, row.tag.toLowerCase().trim());
        }
      );
      console.log(`[MovieLens Import] ${genomeTagNames.size} genome tag names loaded`);

      // Collect genome scores per movie, then store top N in MLTagData
      const genomeMovieTags = new Map<string, { tag: string; relevance: number }[]>();
      const genomeCoveredImdbIds = new Set<string>();
      const genomeParser = createStreamParser(d25m!, "genome-scores.csv");
      for await (const row of genomeParser) {
        const r = row as { movieId: string; tagId: string; relevance: string };
        const imdbId = mlToImdb.get(r.movieId);
        if (!imdbId) continue;
        const relevance = parseFloat(r.relevance);
        if (isNaN(relevance) || relevance < GENOME_MIN_RELEVANCE) continue;
        const tagName = genomeTagNames.get(r.tagId);
        if (!tagName) continue;
        if (!genomeMovieTags.has(imdbId)) genomeMovieTags.set(imdbId, []);
        genomeMovieTags.get(imdbId)!.push({ tag: tagName, relevance });
      }

      // Insert top genome tags per movie into MLTagData
      let mlTagBatch: { imdbId: string; tag: string; relevance: number; source: string }[] = [];
      let totalGenomeTags = 0;
      for (const [imdbId, tags] of genomeMovieTags) {
        const topTags = tags.sort((a, b) => b.relevance - a.relevance).slice(0, MAX_TAGS_PER_MOVIE);
        if (topTags.length > 0) {
          genomeCoveredImdbIds.add(imdbId);
          for (const { tag, relevance } of topTags) {
            mlTagBatch.push({ imdbId, tag, relevance, source: "genome" });
          }
        }
        if (mlTagBatch.length >= BATCH_SIZE) {
          await prisma.mLTagData.createMany({ data: mlTagBatch, skipDuplicates: true });
          totalGenomeTags += mlTagBatch.length;
          mlTagBatch = [];
        }
      }
      if (mlTagBatch.length > 0) {
        await prisma.mLTagData.createMany({ data: mlTagBatch, skipDuplicates: true });
        totalGenomeTags += mlTagBatch.length;
        mlTagBatch = [];
      }
      console.log(
        `[MovieLens Import] Phase A1 done: ${totalGenomeTags} genome tags for ${genomeCoveredImdbIds.size} movies`
      );

      // Phase A2: User-frequency tags from ml-32m → MLTagData (for non-genome movies)
      console.log("[MovieLens Import] Phase A2: Streaming user-frequency tags from ml-32m → MLTagData...");
      // imdbId → tag → Set<userId>
      const movieTagUsers = new Map<string, Map<string, Set<string>>>();
      const tagsParser = createStreamParser(d32m!, "tags.csv");
      for await (const row of tagsParser) {
        const r = row as { userId: string; movieId: string; tag: string };
        const imdbId = mlToImdb.get(r.movieId);
        if (!imdbId || !r.tag) continue;
        if (genomeCoveredImdbIds.has(imdbId)) continue;
        const tag = r.tag.toLowerCase().trim();
        if (tag.length < 2 || tag.length > 50) continue;
        if (!movieTagUsers.has(imdbId)) movieTagUsers.set(imdbId, new Map());
        const tagUsers = movieTagUsers.get(imdbId)!;
        if (!tagUsers.has(tag)) tagUsers.set(tag, new Set());
        tagUsers.get(tag)!.add(r.userId);
      }

      let totalUserTags = 0;
      let userTagBatch: { imdbId: string; tag: string; relevance: number; source: string }[] = [];
      for (const [imdbId, tagUsers] of movieTagUsers) {
        const qualified = [...tagUsers.entries()]
          .filter(([, users]) => users.size >= MIN_USER_TAG_COUNT)
          .map(([tag, users]) => ({ tag, count: users.size }))
          .sort((a, b) => b.count - a.count)
          .slice(0, MAX_TAGS_PER_MOVIE);
        if (qualified.length === 0) continue;
        const maxCount = qualified[0].count;
        for (const { tag, count } of qualified) {
          userTagBatch.push({ imdbId, tag, relevance: count / maxCount, source: "user" });
        }
        if (userTagBatch.length >= BATCH_SIZE) {
          await prisma.mLTagData.createMany({ data: userTagBatch, skipDuplicates: true });
          totalUserTags += userTagBatch.length;
          userTagBatch = [];
        }
      }
      if (userTagBatch.length > 0) {
        await prisma.mLTagData.createMany({ data: userTagBatch, skipDuplicates: true });
        totalUserTags += userTagBatch.length;
      }

      mlTagDataStored = totalGenomeTags + totalUserTags;
      console.log(
        `[MovieLens Import] Phase A done: ${mlTagDataStored} MLTagData rows (${totalGenomeTags} genome + ${totalUserTags} user-frequency)`
      );

      // Phase A (post): Backfill MovieTag for existing local movies
      console.log("[MovieLens Import] Backfilling MovieTag for existing local movies...");
      const localMovies = await prisma.movie.findMany({
        where: { imdbId: { not: null } },
        select: { id: true, imdbId: true },
      });
      for (const m of localMovies) {
        if (!m.imdbId) continue;
        const mlTags = await prisma.mLTagData.findMany({
          where: { imdbId: m.imdbId },
          orderBy: { relevance: "desc" },
          take: MAX_TAGS_PER_MOVIE,
        });
        if (mlTags.length > 0) {
          await prisma.movieTag.createMany({
            data: mlTags.map((t) => ({
              movieId: m.id,
              tag: t.tag,
              relevance: t.relevance,
            })),
            skipDuplicates: true,
          });
          movieTagsBackfilled++;
        }
      }
      const totalMovieTags = await prisma.movieTag.count();
      console.log(
        `[MovieLens Import] MovieTag backfill done: ${totalMovieTags} tags for ${movieTagsBackfilled} movies`
      );
    } else {
      console.log(`[MovieLens Import] Phase A skipped: ${existingMLTagDataCount} MLTagData rows already exist`);
      mlTagDataStored = existingMLTagDataCount;
    }

    // ── Phase B: ALL individual ML ratings by imdbId + per-movie averages ──
    let mlRatingsStored = 0;
    let ratingsUpdated = 0;

    if (!skipRatings) {
      if (existingMLRatingCount > 0) {
        console.log("[MovieLens Import] Clearing existing ML ratings for reimport...");
        // Use raw SQL for fast truncation of millions of rows
        await prisma.$executeRawUnsafe('TRUNCATE TABLE "MLRating"');
      }

      console.log("[MovieLens Import] Phase B: Streaming ratings.csv (storing ALL ratings by imdbId)...");

      let mlBatch: { mlUserId: string; imdbId: string; rating: number }[] = [];
      let totalProcessed = 0;
      let totalInserted = 0;
      const insertStart = Date.now();

      const ratingsParser = createStreamParser(d32m!, "ratings.csv");
      for await (const row of ratingsParser) {
        const r = row as { userId: string; movieId: string; rating: string };
        const imdbId = mlToImdb.get(r.movieId);
        if (!imdbId) continue;
        const rating = parseFloat(r.rating);
        if (isNaN(rating)) continue;

        mlBatch.push({ mlUserId: r.userId, imdbId, rating });
        totalProcessed++;

        if (mlBatch.length >= BATCH_SIZE) {
          await prisma.mLRating.createMany({ data: mlBatch, skipDuplicates: true });
          totalInserted += mlBatch.length;
          mlBatch = [];
          if ((totalInserted / BATCH_SIZE) % 250 === 0) {
            const elapsed = ((Date.now() - insertStart) / 1000).toFixed(0);
            console.log(`[MovieLens Import] Rating insert progress: ${totalInserted} in ${elapsed}s...`);
          }
        }
      }

      if (mlBatch.length > 0) {
        await prisma.mLRating.createMany({ data: mlBatch, skipDuplicates: true });
        totalInserted += mlBatch.length;
      }

      mlRatingsStored = await prisma.mLRating.count();
      const insertSecs = ((Date.now() - insertStart) / 1000).toFixed(1);
      console.log(
        `[MovieLens Import] Stored ${mlRatingsStored} ML ratings in ${insertSecs}s (${totalProcessed} processed)`
      );

      // Update per-movie average ratings for local movies
      console.log("[MovieLens Import] Computing per-movie averages for local movies...");
      const localMovies = await prisma.movie.findMany({
        where: { imdbId: { not: null } },
        select: { id: true, imdbId: true },
      });

      for (let i = 0; i < localMovies.length; i += BATCH_SIZE) {
        const batch = localMovies.slice(i, i + BATCH_SIZE);
        await Promise.all(
          batch.map(async (m) => {
            if (!m.imdbId) return;
            const agg = await prisma.mLRating.aggregate({
              where: { imdbId: m.imdbId },
              _avg: { rating: true },
              _count: { rating: true },
            });
            if (agg._count.rating >= 10 && agg._avg.rating != null) {
              await prisma.movie.update({
                where: { id: m.id },
                data: { letterboxdRating: agg._avg.rating },
              });
              ratingsUpdated++;
            }
          })
        );
      }
      console.log(`[MovieLens Import] Updated ${ratingsUpdated} movies with ML average ratings`);
    } else {
      console.log(`[MovieLens Import] Phase B skipped: ${existingMLRatingCount} ML ratings already exist`);
      mlRatingsStored = existingMLRatingCount;
    }

    console.log(
      `[MovieLens Import] Complete: ${mlTagDataStored} MLTagData, ${movieTagsBackfilled} movies backfilled, ${mlRatingsStored} ratings, ${ratingsUpdated} avg ratings`
    );

    return NextResponse.json({
      message: `Imported ${mlTagDataStored} MLTagData, backfilled ${movieTagsBackfilled} movies, ${mlRatingsStored} ML ratings, ${ratingsUpdated} average ratings`,
      mlTagDataStored,
      movieTagsBackfilled,
      mlRatingsStored,
      ratingsUpdated,
      totalMLMovies: mlToImdb.size,
    });
  } catch (error) {
    console.error("[MovieLens Import] Error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Create a streaming CSV parser from a ZIP entry (for large files) */
function createStreamParser(dir: ZipDirectory, filename: string) {
  const entry = findEntry(dir, filename);
  const stream = entry.stream() as Readable;
  return stream.pipe(parse({ columns: true, skip_empty_lines: true }));
}

/** Get file content as string (only for small files like links.csv, genome-tags.csv) */
async function getFileString(dir: ZipDirectory, filename: string): Promise<string> {
  const entry = findEntry(dir, filename);
  return (await entry.buffer()).toString("utf-8");
}

function findEntry(dir: ZipDirectory, filename: string): ZipEntry {
  const entry = dir.files.find((f) => f.path.endsWith(`/${filename}`) || f.path === filename);
  if (!entry) {
    const available = dir.files
      .map((f) => f.path)
      .slice(0, 20)
      .join(", ");
    throw new Error(`${filename} not found in ZIP. Available: ${available}`);
  }
  return entry;
}

/** Parse a small CSV string */
function parseCsvString<T>(content: string, onRow: (row: T) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const parser = parse(content, { columns: true, skip_empty_lines: true });
    parser.on("data", onRow);
    parser.on("end", resolve);
    parser.on("error", reject);
  });
}
