import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isInternalOrAdmin } from "@/lib/internal-auth";
import { parse } from "csv-parse";

// ml-25m: genome-scores.csv + genome-tags.csv (1128 curated semantic tag scores per movie)
const ML_25M_URL = "https://files.grouplens.org/datasets/movielens/ml-25m.zip";
// ml-32m: tags.csv (user-applied tags), ratings.csv (32M individual ratings), links.csv
const ML_32M_URL = "https://files.grouplens.org/datasets/movielens/ml-32m.zip";
const MAX_TAGS_PER_MOVIE = 15;
const MIN_USER_TAG_COUNT = 3; // Minimum distinct users who must apply a tag for it to count
const GENOME_MIN_RELEVANCE = 0.5; // Minimum genome relevance score to include a tag
const BATCH_SIZE = 2000;

type ZipDirectory = { files: Array<{ path: string; buffer: () => Promise<Buffer> }> };

/**
 * POST /api/movielens/import
 * Import MovieLens data:
 * - Tags: genome scores from ml-25m (primary) + user-frequency from ml-32m (supplementary)
 * - Ratings: ALL individual ML user ratings from ml-32m for MF training
 * - Per-movie averages: stored as letterboxdRating for quality signal
 *
 * Query params:
 * - force=true: reimport tags even if they already exist
 */
export async function POST(req: NextRequest) {
  if (!(await isInternalOrAdmin(req))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const force = req.nextUrl.searchParams.get("force") === "true";

  const [existingTagCount, existingMLRatingCount] = await Promise.all([
    prisma.movieTag.count(),
    prisma.mLRating.count(),
  ]);
  if (!force && existingTagCount > 100 && existingMLRatingCount > 1000) {
    return NextResponse.json({
      message: "MovieLens data already imported (use ?force=true to reimport tags)",
      existingTags: existingTagCount,
      existingMLRatings: existingMLRatingCount,
      skipped: true,
    });
  }

  console.log(`[MovieLens Import] Starting import (force=${force})...`);

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

    // Step 2: Download both datasets in parallel
    console.log("[MovieLens Import] Downloading ml-25m.zip and ml-32m.zip in parallel...");
    const [resp25m, resp32m] = await Promise.all([fetch(ML_25M_URL), fetch(ML_32M_URL)]);
    if (!resp25m.ok) throw new Error(`Failed to download ml-25m: ${resp25m.status}`);
    if (!resp32m.ok) throw new Error(`Failed to download ml-32m: ${resp32m.status}`);

    const [zip25mBuf, zip32mBuf] = await Promise.all([
      resp25m.arrayBuffer().then((b) => Buffer.from(b)),
      resp32m.arrayBuffer().then((b) => Buffer.from(b)),
    ]);
    console.log(
      `[MovieLens Import] Downloaded ml-25m (${(zip25mBuf.length / 1024 / 1024).toFixed(0)}MB) + ml-32m (${(zip32mBuf.length / 1024 / 1024).toFixed(0)}MB)`
    );

    const unzipper = await import("unzipper");
    const [dir25m, dir32m] = await Promise.all([
      unzipper.Open.buffer(zip25mBuf),
      unzipper.Open.buffer(zip32mBuf),
    ]);

    // Step 3: Parse links.csv from ml-32m (superset of ml-25m — all ML movie IDs)
    console.log("[MovieLens Import] Parsing links.csv...");
    const mlToImdb = new Map<string, string>();
    await parseCsv(
      await getFileFromZip(dir32m as ZipDirectory, "links.csv"),
      (row: { movieId: string; imdbId: string }) => {
        if (row.imdbId) mlToImdb.set(row.movieId, `tt${row.imdbId.padStart(7, "0")}`);
      }
    );
    const mlToLocal = new Map<string, string>();
    for (const [mlId, imdbId] of mlToImdb) {
      const localId = imdbToLocalId.get(imdbId);
      if (localId) mlToLocal.set(mlId, localId);
    }
    console.log(`[MovieLens Import] ${mlToLocal.size} movies matched to local DB`);

    // ── Phase A: Tags (genome from ml-25m + user-frequency from ml-32m) ──
    let tagsImported = 0;
    let genomeTagCount = 0;
    const shouldImportTags = force || existingTagCount <= 100;

    if (shouldImportTags) {
      if (existingTagCount > 0) {
        console.log("[MovieLens Import] Clearing existing tags for reimport...");
        await prisma.movieTag.deleteMany();
      }

      // Phase A1: Genome tags from ml-25m (primary — dense, algorithmically computed for 1128 curated tags)
      console.log("[MovieLens Import] Phase A1: Parsing genome data from ml-25m...");
      const genomeTagNames = new Map<string, string>();
      await parseCsv(
        await getFileFromZip(dir25m as ZipDirectory, "genome-tags.csv"),
        (row: { tagId: string; tag: string }) => {
          genomeTagNames.set(row.tagId, row.tag.toLowerCase().trim());
        }
      );
      console.log(`[MovieLens Import] ${genomeTagNames.size} genome tag names loaded`);

      // Parse genome scores — collect tags above threshold per matched movie
      const genomeMovieTags = new Map<string, { tag: string; relevance: number }[]>();
      await parseCsv(
        await getFileFromZip(dir25m as ZipDirectory, "genome-scores.csv"),
        (row: { movieId: string; tagId: string; relevance: string }) => {
          const localId = mlToLocal.get(row.movieId);
          if (!localId) return;
          const relevance = parseFloat(row.relevance);
          if (isNaN(relevance) || relevance < GENOME_MIN_RELEVANCE) return;
          const tagName = genomeTagNames.get(row.tagId);
          if (!tagName) return;
          if (!genomeMovieTags.has(localId)) genomeMovieTags.set(localId, []);
          genomeMovieTags.get(localId)!.push({ tag: tagName, relevance });
        }
      );

      // Insert top genome tags per movie
      const genomeCoveredMovies = new Set<string>();
      const tagBatch: { movieId: string; tag: string; relevance: number }[] = [];
      for (const [localId, tags] of genomeMovieTags) {
        const topTags = tags.sort((a, b) => b.relevance - a.relevance).slice(0, MAX_TAGS_PER_MOVIE);
        if (topTags.length > 0) {
          genomeCoveredMovies.add(localId);
          for (const { tag, relevance } of topTags) {
            tagBatch.push({ movieId: localId, tag, relevance });
          }
        }
        if (tagBatch.length >= BATCH_SIZE) {
          await flushTagBatch(tagBatch.splice(0, tagBatch.length));
        }
      }
      if (tagBatch.length > 0) await flushTagBatch(tagBatch);
      genomeTagCount = await prisma.movieTag.count();
      console.log(
        `[MovieLens Import] Phase A1 done: ${genomeTagCount} genome tags for ${genomeCoveredMovies.size} movies`
      );

      // Phase A2: User-frequency tags from ml-32m (supplementary — for movies NOT covered by genome)
      console.log("[MovieLens Import] Phase A2: Parsing user-frequency tags from ml-32m...");
      const movieTagUsers = new Map<string, Map<string, Set<string>>>();
      await parseCsv(
        await getFileFromZip(dir32m as ZipDirectory, "tags.csv"),
        (row: { userId: string; movieId: string; tag: string }) => {
          const localId = mlToLocal.get(row.movieId);
          if (!localId || !row.tag) return;
          if (genomeCoveredMovies.has(localId)) return; // Skip genome-covered movies
          const tag = row.tag.toLowerCase().trim();
          if (tag.length < 2 || tag.length > 50) return;
          if (!movieTagUsers.has(localId)) movieTagUsers.set(localId, new Map());
          const tagUsers = movieTagUsers.get(localId)!;
          if (!tagUsers.has(tag)) tagUsers.set(tag, new Set());
          tagUsers.get(tag)!.add(row.userId);
        }
      );

      const userTagBatch: { movieId: string; tag: string; relevance: number }[] = [];
      for (const [localId, tagUsers] of movieTagUsers) {
        const qualified = [...tagUsers.entries()]
          .filter(([, users]) => users.size >= MIN_USER_TAG_COUNT)
          .map(([tag, users]) => ({ tag, count: users.size }))
          .sort((a, b) => b.count - a.count)
          .slice(0, MAX_TAGS_PER_MOVIE);
        if (qualified.length === 0) continue;
        const maxCount = qualified[0].count;
        for (const { tag, count } of qualified) {
          userTagBatch.push({ movieId: localId, tag, relevance: count / maxCount });
        }
        if (userTagBatch.length >= BATCH_SIZE) {
          await flushTagBatch(userTagBatch.splice(0, userTagBatch.length));
        }
      }
      if (userTagBatch.length > 0) await flushTagBatch(userTagBatch);

      tagsImported = await prisma.movieTag.count();
      const userTagCount = tagsImported - genomeTagCount;
      console.log(
        `[MovieLens Import] Phase A done: ${tagsImported} total tags (${genomeTagCount} genome + ${userTagCount} user-frequency)`
      );
    } else {
      console.log(`[MovieLens Import] Phase A skipped: ${existingTagCount} tags already exist`);
      tagsImported = existingTagCount;
    }

    // ── Phase B: ALL individual ML ratings + per-movie averages ──
    let mlRatingsStored = 0;
    let ratingsUpdated = 0;

    if (existingMLRatingCount <= 1000) {
      console.log("[MovieLens Import] Phase B: Parsing ratings.csv (storing ALL matching ratings)...");
      const ratingsContent = await getFileFromZip(dir32m as ZipDirectory, "ratings.csv");

      const movieAvgs = new Map<string, { sum: number; count: number }>();
      const mlBatch: { mlUserId: string; movieId: string; rating: number }[] = [];
      let totalMatched = 0;

      await parseCsv(ratingsContent, (row: { userId: string; movieId: string; rating: string }) => {
        const localId = mlToLocal.get(row.movieId);
        if (!localId) return;
        const rating = parseFloat(row.rating);
        if (isNaN(rating)) return;

        if (!movieAvgs.has(localId)) movieAvgs.set(localId, { sum: 0, count: 0 });
        const avg = movieAvgs.get(localId)!;
        avg.sum += rating;
        avg.count++;

        mlBatch.push({ mlUserId: row.userId, movieId: localId, rating });
        totalMatched++;
      });

      console.log(`[MovieLens Import] ${totalMatched} matching ratings found for ${movieAvgs.size} movies`);

      // Batch insert all ML ratings
      console.log("[MovieLens Import] Inserting ML ratings...");
      const insertStart = Date.now();
      for (let i = 0; i < mlBatch.length; i += BATCH_SIZE) {
        const batch = mlBatch.slice(i, i + BATCH_SIZE);
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
      `[MovieLens Import] Complete: ${tagsImported} tags (${genomeTagCount} genome), ${mlRatingsStored} ratings, ${ratingsUpdated} avg ratings`
    );

    return NextResponse.json({
      message: `Imported ${tagsImported} tags (${genomeTagCount} genome), ${mlRatingsStored} ML ratings, ${ratingsUpdated} average ratings`,
      tagsImported,
      genomeTagCount,
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

async function getFileFromZip(dir: ZipDirectory, filename: string): Promise<string> {
  const entry = dir.files.find((f) => f.path.endsWith(`/${filename}`) || f.path === filename);
  if (!entry) {
    const available = dir.files
      .map((f) => f.path)
      .slice(0, 20)
      .join(", ");
    throw new Error(`${filename} not found in ZIP. Available: ${available}`);
  }
  return (await entry.buffer()).toString("utf-8");
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
