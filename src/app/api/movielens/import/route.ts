import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isInternalOrAdmin } from "@/lib/internal-auth";
import { parse } from "csv-parse";

const ML_32M_URL = "https://files.grouplens.org/datasets/movielens/ml-32m.zip";
const MAX_TAGS_PER_MOVIE = 15;
const MIN_RELEVANCE = 0.5;
const BATCH_SIZE = 100;

/**
 * POST /api/movielens/import
 * Download ML-32M dataset, extract tag genome data, and import into MovieTag table.
 * Matches MovieLens movies to local movies via imdbId.
 * Idempotent: skips movies that already have tags.
 */
export async function POST(req: NextRequest) {
  if (!(await isInternalOrAdmin(req))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Check if we already have a substantial number of tags — skip if so (idempotent)
  const existingTagCount = await prisma.movieTag.count();
  if (existingTagCount > 100) {
    return NextResponse.json({
      message: "Tags already imported",
      existingTags: existingTagCount,
      skipped: true,
    });
  }

  console.log("[MovieLens Import] Starting tag genome import from ML-32M...");

  try {
    // Step 1: Download the ZIP file
    console.log("[MovieLens Import] Downloading ml-32m.zip...");
    const response = await fetch(ML_32M_URL);
    if (!response.ok) {
      throw new Error(`Failed to download ML-32M: ${response.status} ${response.statusText}`);
    }

    const zipBuffer = Buffer.from(await response.arrayBuffer());
    console.log(`[MovieLens Import] Downloaded ${(zipBuffer.length / 1024 / 1024).toFixed(0)}MB`);

    // Step 2: Extract required CSV files using unzipper
    const unzipper = await import("unzipper");
    const directory = await unzipper.Open.buffer(zipBuffer);

    const getFileContent = async (filename: string): Promise<string> => {
      const entry = directory.files.find((f) => f.path.endsWith(`/${filename}`) || f.path === filename);
      if (!entry) {
        // Log available files for debugging
        const available = directory.files.map((f) => f.path).slice(0, 20).join(", ");
        throw new Error(`${filename} not found in ZIP. Available: ${available}`);
      }
      const buf = await entry.buffer();
      return buf.toString("utf-8");
    };

    // Step 3: Parse genome-tags.csv → tagId → tagName
    console.log("[MovieLens Import] Parsing genome-tags.csv...");
    const genomeTagsContent = await getFileContent("genome-tags.csv");
    const tagMap = new Map<string, string>(); // tagId → tagName
    await new Promise<void>((resolve, reject) => {
      const parser = parse(genomeTagsContent, { columns: true, skip_empty_lines: true });
      parser.on("data", (row: { tagId: string; tag: string }) => {
        tagMap.set(row.tagId, row.tag);
      });
      parser.on("end", resolve);
      parser.on("error", reject);
    });
    console.log(`[MovieLens Import] Loaded ${tagMap.size} genome tags`);

    // Step 4: Parse links.csv → mlMovieId → imdbId
    console.log("[MovieLens Import] Parsing links.csv...");
    const linksContent = await getFileContent("links.csv");
    const mlToImdb = new Map<string, string>(); // mlMovieId → imdbId (formatted as tt0000000)
    await new Promise<void>((resolve, reject) => {
      const parser = parse(linksContent, { columns: true, skip_empty_lines: true });
      parser.on("data", (row: { movieId: string; imdbId: string; tmdbId: string }) => {
        if (row.imdbId) {
          // MovieLens stores imdbId without "tt" prefix, pad to 7 digits
          mlToImdb.set(row.movieId, `tt${row.imdbId.padStart(7, "0")}`);
        }
      });
      parser.on("end", resolve);
      parser.on("error", reject);
    });
    console.log(`[MovieLens Import] Loaded ${mlToImdb.size} movie links`);

    // Step 5: Get all local movies with imdbId for matching
    const localMovies = await prisma.movie.findMany({
      where: { imdbId: { not: null } },
      select: { id: true, imdbId: true },
    });
    const imdbToLocalId = new Map<string, string>();
    for (const m of localMovies) {
      if (m.imdbId) imdbToLocalId.set(m.imdbId, m.id);
    }
    console.log(`[MovieLens Import] ${localMovies.length} local movies with imdbId`);

    // Build reverse mapping: mlMovieId → localMovieId
    const mlToLocalId = new Map<string, string>();
    for (const [mlId, imdbId] of mlToImdb) {
      const localId = imdbToLocalId.get(imdbId);
      if (localId) mlToLocalId.set(mlId, localId);
    }
    console.log(`[MovieLens Import] ${mlToLocalId.size} MovieLens movies matched to local DB`);

    if (mlToLocalId.size === 0) {
      return NextResponse.json({
        message: "No MovieLens movies matched local database",
        localMovies: localMovies.length,
        mlLinks: mlToImdb.size,
      });
    }

    // Step 6: Parse genome-scores.csv and collect top tags per matched movie
    console.log("[MovieLens Import] Parsing genome-scores.csv (this may take a while)...");
    const genomeScoresContent = await getFileContent("genome-scores.csv");

    // Collect scores per movie: mlMovieId → [{tagId, relevance}]
    const movieScores = new Map<string, { tagId: string; relevance: number }[]>();

    await new Promise<void>((resolve, reject) => {
      const parser = parse(genomeScoresContent, { columns: true, skip_empty_lines: true });
      parser.on("data", (row: { movieId: string; tagId: string; relevance: string }) => {
        // Only process movies that match our local DB
        if (!mlToLocalId.has(row.movieId)) return;

        const relevance = parseFloat(row.relevance);
        if (relevance < MIN_RELEVANCE) return;

        if (!movieScores.has(row.movieId)) {
          movieScores.set(row.movieId, []);
        }
        movieScores.get(row.movieId)!.push({ tagId: row.tagId, relevance });
      });
      parser.on("end", resolve);
      parser.on("error", reject);
    });

    console.log(`[MovieLens Import] Collected scores for ${movieScores.size} matched movies`);

    // Step 7: Insert tags into database
    let tagsImported = 0;
    let moviesProcessed = 0;
    const upsertBatch: { movieId: string; tag: string; relevance: number }[] = [];

    for (const [mlMovieId, scores] of movieScores) {
      const localMovieId = mlToLocalId.get(mlMovieId)!;

      // Sort by relevance descending, take top N
      scores.sort((a, b) => b.relevance - a.relevance);
      const topScores = scores.slice(0, MAX_TAGS_PER_MOVIE);

      for (const { tagId, relevance } of topScores) {
        const tagName = tagMap.get(tagId);
        if (!tagName) continue;

        upsertBatch.push({ movieId: localMovieId, tag: tagName, relevance });
      }

      // Flush batch
      if (upsertBatch.length >= BATCH_SIZE) {
        await flushBatch(upsertBatch);
        tagsImported += upsertBatch.length;
        upsertBatch.length = 0;
      }

      moviesProcessed++;
      if (moviesProcessed % 500 === 0) {
        console.log(`[MovieLens Import] Processed ${moviesProcessed}/${movieScores.size} movies...`);
      }
    }

    // Flush remaining
    if (upsertBatch.length > 0) {
      await flushBatch(upsertBatch);
      tagsImported += upsertBatch.length;
    }

    console.log(
      `[MovieLens Import] Done. ${moviesProcessed} movies, ${tagsImported} tags imported, ${localMovies.length - moviesProcessed} unmatched`
    );

    return NextResponse.json({
      message: `Imported ${tagsImported} tags for ${moviesProcessed} movies`,
      moviesMatched: moviesProcessed,
      tagsImported,
      moviesUnmatched: localMovies.length - moviesProcessed,
      totalGenomeTags: tagMap.size,
    });
  } catch (error) {
    console.error("[MovieLens Import] Error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function flushBatch(batch: { movieId: string; tag: string; relevance: number }[]) {
  // Use createMany with skipDuplicates for idempotency
  await prisma.movieTag.createMany({
    data: batch.map((b) => ({
      movieId: b.movieId,
      tag: b.tag,
      relevance: b.relevance,
    })),
    skipDuplicates: true,
  });
}
