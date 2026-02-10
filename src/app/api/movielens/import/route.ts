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

function normalizeMlGenreName(name: string): string | null {
  const n = name.trim();
  if (!n || n === "(no genres listed)") return null;
  switch (n.toLowerCase()) {
    case "sci-fi":
      return "Science Fiction";
    case "children":
      return "Family";
    default:
      // Title-case-ish for common ML genre strings (they are usually already proper case).
      return n;
  }
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}

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
 * - createMlMovies=true: create ML-only Movie rows from MovieLens catalog (lazy-hydrated if shown)
 * - minMlVotes=750: minimum MovieLens rating count to include in ML-only catalog
 * - maxMlMovies=20000: cap ML-only movie creation per import run (safety)
 */
export async function POST(req: NextRequest) {
  if (!(await isInternalOrAdmin(req))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const force = req.nextUrl.searchParams.get("force") === "true";
  const forceRatings = req.nextUrl.searchParams.get("forceRatings") === "true";
  const createMlMovies = req.nextUrl.searchParams.get("createMlMovies") === "true";
  const minMlVotesRaw = req.nextUrl.searchParams.get("minMlVotes");
  const maxMlMoviesRaw = req.nextUrl.searchParams.get("maxMlMovies");
  const minMlVotes =
    minMlVotesRaw && Number.isFinite(Number(minMlVotesRaw))
      ? Math.max(0, Math.floor(Number(minMlVotesRaw)))
      : 750;
  const maxMlMovies =
    maxMlMoviesRaw && Number.isFinite(Number(maxMlMoviesRaw))
      ? Math.max(0, Math.floor(Number(maxMlMoviesRaw)))
      : 20_000;

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

    // Step 2b: Parse movies.csv so we can create ML-only Movie rows (title + year) without hitting external APIs.
    const imdbToCatalogMeta = new Map<string, { title: string; year: number | null; genres: string[] }>();
    if (d32m && createMlMovies) {
      console.log("[MovieLens Import] Parsing movies.csv (catalog metadata)...");
      const mlMovieMeta = new Map<string, { title: string; year: number | null; genres: string[] }>();

      await parseCsvString(
        await getFileString(d32m, "movies.csv"),
        (row: { movieId: string; title: string; genres: string }) => {
          const rawTitle = (row.title || "").trim();
          if (!row.movieId || !rawTitle) return;
          const match = rawTitle.match(/^(.*)\\s*\\((\\d{4})\\)\\s*$/);
          const title = match ? match[1].trim() : rawTitle;
          const year = match ? Number.parseInt(match[2], 10) : null;

          const genreNames = (row.genres || "")
            .split("|")
            .map((g) => normalizeMlGenreName(g))
            .filter(Boolean) as string[];

          mlMovieMeta.set(row.movieId, {
            title,
            year: Number.isFinite(year as number) ? year : null,
            genres: Array.from(new Set(genreNames)).slice(0, 6),
          });
        }
      );

      for (const [mlMovieId, imdbId] of mlToImdb.entries()) {
        const meta = mlMovieMeta.get(mlMovieId);
        if (!meta) continue;
        if (!imdbToCatalogMeta.has(imdbId)) {
          imdbToCatalogMeta.set(imdbId, meta);
        }
      }
      console.log(`[MovieLens Import] Catalog meta mapped for ${imdbToCatalogMeta.size} imdbIds`);
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
    let mlOnlyMoviesCreated = 0;

    if (!skipRatings) {
      if (existingMLRatingCount > 0) {
        console.log("[MovieLens Import] Clearing existing ML ratings for reimport...");
        // Use raw SQL for fast truncation of millions of rows
        await prisma.$executeRawUnsafe('TRUNCATE TABLE "MLRating"');
      }

      console.log("[MovieLens Import] Phase B: Streaming ratings.csv (storing ALL ratings by imdbId)...");

      let mlBatch: { mlUserId: string; imdbId: string; rating: number }[] = [];
      const ratingStats = new Map<string, { sum: number; count: number }>();
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

        // Per-imdbId stats for creating ML-only movies and faster local avg updates.
        const current = ratingStats.get(imdbId);
        if (current) {
          current.sum += rating;
          current.count += 1;
        } else {
          ratingStats.set(imdbId, { sum: rating, count: 1 });
        }

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

      // Update per-movie average ratings + ML rating counts for local movies (no per-movie SQL aggregates).
      console.log("[MovieLens Import] Updating per-movie averages for local movies...");
      const localMovies = await prisma.movie.findMany({
        where: { imdbId: { not: null } },
        select: { id: true, imdbId: true },
      });

      const UPDATE_CONCURRENCY = 25;
      for (let i = 0; i < localMovies.length; i += BATCH_SIZE) {
        const batch = localMovies.slice(i, i + BATCH_SIZE);
        for (let j = 0; j < batch.length; j += UPDATE_CONCURRENCY) {
          const slice = batch.slice(j, j + UPDATE_CONCURRENCY);
          await Promise.all(
            slice.map(async (m) => {
              if (!m.imdbId) return;
              const stats = ratingStats.get(m.imdbId);
              if (!stats) return;
              const avg = stats.count > 0 ? stats.sum / stats.count : null;
              if (stats.count >= 10 && avg != null) {
                await prisma.movie.update({
                  where: { id: m.id },
                  data: { letterboxdRating: avg, mlRatingCount: stats.count },
                });
                ratingsUpdated++;
              } else if (stats.count > 0) {
                await prisma.movie.update({
                  where: { id: m.id },
                  data: { mlRatingCount: stats.count },
                });
              }
            })
          );
        }
      }
      console.log(`[MovieLens Import] Updated ${ratingsUpdated} movies with ML average ratings`);

      // Optionally create ML-only Movie rows (no poster/overview; hydrated only if shown to a user).
      if (createMlMovies) {
        console.log(
          `[MovieLens Import] Creating ML-only Movie rows (minMlVotes=${minMlVotes}, maxMlMovies=${maxMlMovies})...`
        );

        const candidates: Array<{
          imdbId: string;
          title: string;
          year: number | null;
          letterboxdRating: number | null;
          mlRatingCount: number;
          genres: string[];
        }> = [];

        for (const [imdbId, stats] of ratingStats.entries()) {
          if (stats.count < minMlVotes) continue;
          const meta = imdbToCatalogMeta.get(imdbId);
          if (!meta?.title) continue;
          const avg = stats.count > 0 ? stats.sum / stats.count : null;
          candidates.push({
            imdbId,
            title: meta.title,
            year: meta.year,
            genres: meta.genres || [],
            letterboxdRating: avg,
            mlRatingCount: stats.count,
          });
        }

        candidates.sort((a, b) => b.mlRatingCount - a.mlRatingCount);
        const toCreate = candidates.slice(0, maxMlMovies);

        // Ensure genres exist up-front (small set).
        const allGenres = new Set<string>();
        for (const c of toCreate) for (const g of c.genres) allGenres.add(g);
        const genreRows = Array.from(allGenres.values());
        for (const name of genreRows) {
          const slug = slugify(name);
          if (!slug) continue;
          await prisma.genre.upsert({
            where: { slug },
            create: { name, slug },
            update: { name },
          });
        }
        const genreByName = new Map(
          (await prisma.genre.findMany({ select: { id: true, name: true } })).map((g) => [g.name, g.id])
        );

        for (let i = 0; i < toCreate.length; i += BATCH_SIZE) {
          const chunk = toCreate.slice(i, i + BATCH_SIZE);
          await prisma.movie.createMany({
            data: chunk.map((m) => ({
              imdbId: m.imdbId,
              isMlOnly: true,
              title: m.title,
              year: m.year ?? undefined,
              era: m.year ? (m.year >= new Date().getFullYear() - 1 ? "new_release" : m.year >= 2000 ? "modern_classic" : "classic") : undefined,
              letterboxdRating: m.letterboxdRating ?? undefined,
              mlRatingCount: m.mlRatingCount,
            })),
            skipDuplicates: true,
          });

          // Attach MovieLens genres (no network calls; improves clustering and MF features).
          const created = await prisma.movie.findMany({
            where: { imdbId: { in: chunk.map((c) => c.imdbId) } },
            select: { id: true, imdbId: true },
          });
          const idByImdb = new Map(created.map((m) => [m.imdbId as string, m.id]));

          const movieGenreRows: { movieId: string; genreId: string }[] = [];
          for (const m of chunk) {
            const movieId = idByImdb.get(m.imdbId);
            if (!movieId) continue;
            for (const g of m.genres) {
              const genreId = genreByName.get(g);
              if (!genreId) continue;
              movieGenreRows.push({ movieId, genreId });
            }
          }
          if (movieGenreRows.length > 0) {
            await prisma.movieGenre.createMany({ data: movieGenreRows, skipDuplicates: true });
          }
        }

        // Count how many ML-only rows exist now (rough progress metric).
        mlOnlyMoviesCreated = await prisma.movie.count({ where: { isMlOnly: true } });
        console.log(`[MovieLens Import] ML-only Movie rows present: ${mlOnlyMoviesCreated}`);
      }
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
      mlOnlyMoviesCreated,
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
