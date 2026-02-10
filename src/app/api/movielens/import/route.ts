import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isInternalOrAdmin } from "@/lib/internal-auth";
import { parse } from "csv-parse";

// ml-32m has tags.csv (user-applied tags), ratings.csv (32M individual ratings), links.csv
const ML_32M_URL = "https://files.grouplens.org/datasets/movielens/ml-32m.zip";
const MAX_TAGS_PER_MOVIE = 15;
const MIN_USER_TAG_COUNT = 3; // Minimum distinct users who must apply a tag for it to count
const BATCH_SIZE = 2000;

/**
 * POST /api/movielens/import
 * Import MovieLens data from ml-32m:
 * - Tags: computed from user tagging frequency (distinct users per tag per movie)
 * - Ratings: ALL individual ML user ratings for matched movies, stored for MF training
 * - Per-movie averages: stored as letterboxdRating for quality signal
 */
export async function POST(req: NextRequest) {
  if (!(await isInternalOrAdmin(req))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Idempotency check
  const [existingTagCount, existingMLRatingCount] = await Promise.all([
    prisma.movieTag.count(),
    prisma.mLRating.count(),
  ]);
  if (existingTagCount > 100 && existingMLRatingCount > 1000) {
    return NextResponse.json({
      message: "MovieLens data already imported",
      existingTags: existingTagCount,
      existingMLRatings: existingMLRatingCount,
      skipped: true,
    });
  }

  console.log("[MovieLens Import] Starting ml-32m import (tags + full ratings)...");

  try {
    // Step 1: Get all local movies with imdbId for matching
    const localMovies = await prisma.movie.findMany({
      where: { imdbId: { not: null } },
      select: { id: true, imdbId: true },
    });
    const imdbToLocalId = new Map<string, string>();
    for (const m of localMovies) {
      if (m.imdbId) imdbToLocalId.set(m.imdbId, m.id);
    }
    console.log(`[MovieLens Import] ${localMovies.length} local movies with imdbId`);

    // Step 2: Download ml-32m
    console.log("[MovieLens Import] Downloading ml-32m.zip...");
    const resp = await fetch(ML_32M_URL);
    if (!resp.ok) throw new Error(`Failed to download ml-32m: ${resp.status}`);
    const zipBuffer = Buffer.from(await resp.arrayBuffer());
    console.log(`[MovieLens Import] Downloaded ml-32m (${(zipBuffer.length / 1024 / 1024).toFixed(0)}MB)`);

    const unzipper = await import("unzipper");
    const dir = await unzipper.Open.buffer(zipBuffer);

    const getFile = async (filename: string): Promise<string> => {
      const entry = dir.files.find((f) => f.path.endsWith(`/${filename}`) || f.path === filename);
      if (!entry) {
        const available = dir.files.map((f) => f.path).slice(0, 20).join(", ");
        throw new Error(`${filename} not found in ZIP. Available: ${available}`);
      }
      return (await entry.buffer()).toString("utf-8");
    };

    // Step 3: Parse links.csv → ML movieId → imdbId → local movieId
    console.log("[MovieLens Import] Parsing links.csv...");
    const mlToImdb = new Map<string, string>();
    await parseCsv(await getFile("links.csv"), (row: { movieId: string; imdbId: string }) => {
      if (row.imdbId) mlToImdb.set(row.movieId, `tt${row.imdbId.padStart(7, "0")}`);
    });
    const mlToLocal = new Map<string, string>();
    for (const [mlId, imdbId] of mlToImdb) {
      const localId = imdbToLocalId.get(imdbId);
      if (localId) mlToLocal.set(mlId, localId);
    }
    console.log(`[MovieLens Import] ${mlToLocal.size} ml-32m movies matched to local DB`);

    // ── Phase A: User-frequency tag relevance ──
    let tagsImported = 0;
    // If tags exist but ML ratings don't, the old tags are genome-based (ml-25m) — clear and re-import
    if (existingTagCount > 0 && existingMLRatingCount <= 1000) {
      console.log("[MovieLens Import] Clearing old genome-based tags for user-frequency re-import...");
      await prisma.movieTag.deleteMany();
    }
    const currentTagCount = await prisma.movieTag.count();
    if (currentTagCount <= 100) {
      console.log("[MovieLens Import] Phase A: Parsing tags.csv for user-frequency tag relevance...");
      const movieTagUsers = new Map<string, Map<string, Set<string>>>();
      await parseCsv(
        await getFile("tags.csv"),
        (row: { userId: string; movieId: string; tag: string }) => {
          const localId = mlToLocal.get(row.movieId);
          if (!localId || !row.tag) return;
          const tag = row.tag.toLowerCase().trim();
          if (tag.length < 2 || tag.length > 50) return;
          if (!movieTagUsers.has(localId)) movieTagUsers.set(localId, new Map());
          const tagUsers = movieTagUsers.get(localId)!;
          if (!tagUsers.has(tag)) tagUsers.set(tag, new Set());
          tagUsers.get(tag)!.add(row.userId);
        }
      );

      console.log(`[MovieLens Import] Tag data for ${movieTagUsers.size} movies`);

      const tagBatch: { movieId: string; tag: string; relevance: number }[] = [];
      for (const [localId, tagUsers] of movieTagUsers) {
        const qualified = [...tagUsers.entries()]
          .filter(([, users]) => users.size >= MIN_USER_TAG_COUNT)
          .map(([tag, users]) => ({ tag, count: users.size }))
          .sort((a, b) => b.count - a.count)
          .slice(0, MAX_TAGS_PER_MOVIE);

        if (qualified.length === 0) continue;

        const maxCount = qualified[0].count;
        for (const { tag, count } of qualified) {
          tagBatch.push({ movieId: localId, tag, relevance: count / maxCount });
        }

        if (tagBatch.length >= BATCH_SIZE) {
          await flushTagBatch(tagBatch.splice(0, tagBatch.length));
        }
      }
      if (tagBatch.length > 0) {
        await flushTagBatch(tagBatch);
      }
      tagsImported = await prisma.movieTag.count();
      console.log(`[MovieLens Import] Phase A done: ${tagsImported} tags imported`);
    } else {
      console.log(`[MovieLens Import] Phase A skipped: ${currentTagCount} tags already exist`);
      tagsImported = currentTagCount;
    }

    // ── Phase B: ALL individual ML ratings + per-movie averages ──
    let mlRatingsStored = 0;
    let ratingsUpdated = 0;

    if (existingMLRatingCount <= 1000) {
      console.log("[MovieLens Import] Phase B: Parsing ratings.csv (storing ALL matching ratings)...");
      const ratingsContent = await getFile("ratings.csv");

      // Single pass: stream all matching ratings into batches + compute per-movie averages
      const movieAvgs = new Map<string, { sum: number; count: number }>();
      let mlBatch: { mlUserId: string; movieId: string; rating: number }[] = [];
      let totalMatched = 0;

      await parseCsv(ratingsContent, async (row: { userId: string; movieId: string; rating: string }) => {
        const localId = mlToLocal.get(row.movieId);
        if (!localId) return;
        const rating = parseFloat(row.rating);
        if (isNaN(rating)) return;

        // Track per-movie average
        if (!movieAvgs.has(localId)) movieAvgs.set(localId, { sum: 0, count: 0 });
        const avg = movieAvgs.get(localId)!;
        avg.sum += rating;
        avg.count++;

        // Buffer individual rating for batch insert
        mlBatch.push({ mlUserId: row.userId, movieId: localId, rating });
        totalMatched++;
      });

      console.log(`[MovieLens Import] ${totalMatched} matching ratings found for ${movieAvgs.size} movies`);

      // Batch insert all ML ratings using raw SQL for performance
      console.log("[MovieLens Import] Inserting ML ratings...");
      const insertStart = Date.now();
      for (let i = 0; i < mlBatch.length; i += BATCH_SIZE) {
        const batch = mlBatch.slice(i, i + BATCH_SIZE);
        // Use createMany with skipDuplicates for composite PK safety
        await prisma.mLRating.createMany({
          data: batch,
          skipDuplicates: true,
        });
        if ((i / BATCH_SIZE) % 100 === 0 && i > 0) {
          const pct = ((i / mlBatch.length) * 100).toFixed(1);
          console.log(`[MovieLens Import] Rating insert progress: ${pct}% (${i}/${mlBatch.length})`);
        }
      }
      mlRatingsStored = await prisma.mLRating.count();
      const insertSecs = ((Date.now() - insertStart) / 1000).toFixed(1);
      console.log(`[MovieLens Import] Stored ${mlRatingsStored} ML ratings in ${insertSecs}s`);

      // Update per-movie average ratings
      console.log("[MovieLens Import] Updating per-movie average ratings...");
      const ratingUpdates: { id: string; avgRating: number }[] = [];
      for (const [localId, avg] of movieAvgs) {
        if (avg.count >= 10) {
          ratingUpdates.push({ id: localId, avgRating: avg.sum / avg.count });
        }
      }

      for (let i = 0; i < ratingUpdates.length; i += BATCH_SIZE) {
        const batch = ratingUpdates.slice(i, i + BATCH_SIZE);
        await Promise.all(
          batch.map((b) =>
            prisma.movie.update({
              where: { id: b.id },
              data: { letterboxdRating: b.avgRating },
            })
          )
        );
        ratingsUpdated += batch.length;
      }
      console.log(`[MovieLens Import] Updated ${ratingsUpdated} movies with ML average ratings`);
    } else {
      console.log(`[MovieLens Import] Phase B skipped: ${existingMLRatingCount} ML ratings already exist`);
      mlRatingsStored = existingMLRatingCount;
    }

    console.log(
      `[MovieLens Import] Complete: ${tagsImported} tags, ${mlRatingsStored} ratings, ${ratingsUpdated} avg ratings`
    );

    return NextResponse.json({
      message: `Imported ${tagsImported} tags, ${mlRatingsStored} ML ratings, ${ratingsUpdated} average ratings`,
      tagsImported,
      mlRatingsStored,
      ratingsUpdated,
      moviesMatched: mlToLocal.size,
    });
  } catch (error) {
    console.error("[MovieLens Import] Error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function flushTagBatch(batch: { movieId: string; tag: string; relevance: number }[]) {
  await prisma.movieTag.createMany({
    data: batch.map((b) => ({
      movieId: b.movieId,
      tag: b.tag,
      relevance: b.relevance,
    })),
    skipDuplicates: true,
  });
}

function parseCsv<T>(content: string, onRow: (row: T) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const parser = parse(content, { columns: true, skip_empty_lines: true });
    parser.on("data", onRow);
    parser.on("end", resolve);
    parser.on("error", reject);
  });
}
