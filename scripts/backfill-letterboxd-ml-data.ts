/* eslint-disable @typescript-eslint/no-explicit-any */
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { shouldRetrain, trainMatrixFactorization } from "../src/lib/matrix-factorization";

const connectionString = "postgresql://movienight:movienight@127.0.0.1:5432/movienight?schema=public";
const pool = new pg.Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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

function parseYearFromDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isNaN(n) ? null : n;
}

function buildTitleVariants(title: string): string[] {
  const trimmed = title.trim();
  const variants = new Set<string>();
  if (!trimmed) return [];

  variants.add(trimmed);
  variants.add(trimmed.replace(/,+\s*\d{4}-\d{2}-\d{2}\s*$/i, "").trim());
  variants.add(trimmed.replace(/\s*,\s*[a-z0-9_-]{3,}\s*$/i, "").trim());
  variants.add(trimmed.replace(/["“”'`]/g, "").trim());

  if (trimmed.includes(",")) {
    variants.add(trimmed.split(",")[0].trim());
  }

  const cleaned = Array.from(variants)
    .map((v) => v.replace(/\s+/g, " ").trim())
    .filter((v) => v.length >= 2 && v.length <= 120);

  return Array.from(new Set(cleaned));
}

function isClearlyMalformedTitle(title: string, year: number | null): boolean {
  const t = title.trim();
  if (!t) return true;
  const words = t.split(/\s+/).filter(Boolean);
  const lower = t.toLowerCase();

  if (year !== null && year >= 1888 && year <= 2100 && words.length <= 10 && t.length <= 80) {
    return false;
  }

  if (t.includes("blockquote") || t.includes("</") || t.includes("http://") || t.includes("https://")) {
    return true;
  }

  if (/,,\d{4}-\d{2}-\d{2}/.test(t)) return true;
  if (t.length > 110) return true;
  if (words.length >= 14 && year === null) return true;
  if (/,\d{4}-\d{2}-\d{2}$/.test(lower)) return true;

  return false;
}

async function getApiKeys() {
  const configs = await prisma.integrationConfig.findMany({
    where: { service: { in: ["tmdb"] } },
    select: { service: true, enabled: true, apiKey: true },
  });

  const tmdbCfg = configs.find((c) => c.service === "tmdb");
  return {
    tmdb: tmdbCfg?.enabled && tmdbCfg.apiKey ? tmdbCfg.apiKey : process.env.TMDB_API_KEY || null,
  };
}

async function searchTMDB(query: string, tmdbKey: string) {
  const res = await fetch(`https://api.themoviedb.org/3/search/movie?api_key=${tmdbKey}&query=${encodeURIComponent(query)}`);
  if (!res.ok) return [] as any[];
  const data = await res.json().catch(() => null);
  return Array.isArray(data?.results) ? data.results : [];
}

async function getTMDBDetails(tmdbId: string, tmdbKey: string) {
  const res = await fetch(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${tmdbKey}&append_to_response=credits,external_ids`);
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

async function findOrCreatePersonIdByName(name: string, tmdbId?: number | null): Promise<string | null> {
  const trimmed = name?.trim();
  if (!trimmed) return null;

  if (tmdbId) {
    const existingByTmdb = await prisma.person.findFirst({ where: { tmdbId: String(tmdbId) }, select: { id: true } });
    if (existingByTmdb) return existingByTmdb.id;
  }

  const existingByName = await prisma.person.findFirst({
    where: { name: { equals: trimmed, mode: "insensitive" } },
    select: { id: true },
  });
  if (existingByName) {
    if (tmdbId) {
      await prisma.person.update({ where: { id: existingByName.id }, data: { tmdbId: String(tmdbId) } }).catch(() => undefined);
    }
    return existingByName.id;
  }

  const created = await prisma.person.create({
    data: {
      name: trimmed,
      ...(tmdbId ? { tmdbId: String(tmdbId) } : {}),
    },
    select: { id: true },
  });

  return created.id;
}

async function upsertRelationsFromTMDB(movieId: string, tmdb: any) {
  // Genres
  if (Array.isArray(tmdb.genres)) {
    for (const genre of tmdb.genres) {
      const name = typeof genre?.name === "string" ? genre.name.trim() : "";
      if (!name) continue;
      const slug = slugify(name);
      if (!slug) continue;

      const g = await prisma.genre.upsert({
        where: { slug },
        create: { name, slug },
        update: { name },
        select: { id: true },
      });

      await prisma.movieGenre.upsert({
        where: { movieId_genreId: { movieId, genreId: g.id } },
        create: { movieId, genreId: g.id },
        update: {},
      });
    }
  }

  // Studios
  if (Array.isArray(tmdb.production_companies)) {
    for (const company of tmdb.production_companies.slice(0, 5)) {
      const name = typeof company?.name === "string" ? company.name.trim() : "";
      if (!name) continue;
      const slug = slugify(name);
      if (!slug) continue;

      let studio = await prisma.studio.findFirst({
        where: { OR: [{ slug }, { name }] },
        select: { id: true },
      });

      if (!studio) {
        studio = await prisma.studio.create({ data: { name, slug }, select: { id: true } });
      }

      await prisma.movieStudio.upsert({
        where: { movieId_studioId: { movieId, studioId: studio.id } },
        create: { movieId, studioId: studio.id },
        update: {},
      });
    }
  }

  // Cast
  if (Array.isArray(tmdb.credits?.cast)) {
    for (const cast of tmdb.credits.cast.slice(0, 8)) {
      const personId = await findOrCreatePersonIdByName(cast?.name, cast?.id ?? null);
      if (!personId) continue;

      await prisma.movieCast.upsert({
        where: { movieId_personId: { movieId, personId } },
        create: { movieId, personId, castOrder: typeof cast?.order === "number" ? cast.order : null, character: typeof cast?.character === "string" ? cast.character : null },
        update: { castOrder: typeof cast?.order === "number" ? cast.order : undefined, character: typeof cast?.character === "string" ? cast.character : undefined },
      });
    }
  }

  // Director(s)
  if (Array.isArray(tmdb.credits?.crew)) {
    for (const crew of tmdb.credits.crew) {
      if (crew?.job !== "Director") continue;
      const personId = await findOrCreatePersonIdByName(crew?.name, crew?.id ?? null);
      if (!personId) continue;

      await prisma.movieCrew.upsert({
        where: { movieId_personId_job: { movieId, personId, job: "Director" } },
        create: { movieId, personId, job: "Director" },
        update: {},
      });
    }
  }
}

async function mergeMovieIntoTarget(sourceMovieId: string, targetMovieId: string): Promise<void> {
  if (sourceMovieId === targetMovieId) return;

  const sourceRatings = await prisma.movieRating.findMany({
    where: { movieId: sourceMovieId },
    select: { id: true, userId: true, rating: true, hasSeen: true, notHeardOf: true },
  });

  for (const rating of sourceRatings) {
    const existing = await prisma.movieRating.findUnique({
      where: { userId_movieId: { userId: rating.userId, movieId: targetMovieId } },
    });

    if (!existing) {
      await prisma.movieRating.update({ where: { id: rating.id }, data: { movieId: targetMovieId } });
      continue;
    }

    const mergedRating = existing.rating ?? rating.rating;
    const mergedHasSeen = existing.hasSeen || rating.hasSeen;
    const mergedNotHeardOf = mergedRating === null ? existing.notHeardOf && rating.notHeardOf : false;

    await prisma.movieRating.update({
      where: { id: existing.id },
      data: { rating: mergedRating, hasSeen: mergedHasSeen, notHeardOf: mergedNotHeardOf },
    });

    await prisma.movieRating.delete({ where: { id: rating.id } });
  }

  const refs = await Promise.all([
    prisma.movieRating.count({ where: { movieId: sourceMovieId } }),
    prisma.sessionMovie.count({ where: { movieId: sourceMovieId } }),
    prisma.movieGenre.count({ where: { movieId: sourceMovieId } }),
    prisma.movieStudio.count({ where: { movieId: sourceMovieId } }),
    prisma.movieCast.count({ where: { movieId: sourceMovieId } }),
    prisma.movieCrew.count({ where: { movieId: sourceMovieId } }),
    prisma.radarrSync.count({ where: { movieId: sourceMovieId } }),
    prisma.plexAvailability.count({ where: { movieId: sourceMovieId } }),
  ]);

  if (refs.reduce((a, b) => a + b, 0) === 0) {
    await prisma.movie.delete({ where: { id: sourceMovieId } });
  }
}

async function run() {
  const nowYear = new Date().getUTCFullYear();
  const { tmdb } = await getApiKeys();
  if (!tmdb) {
    throw new Error("TMDB API key not configured; cannot complete remediation/backfill.");
  }

  const importUsers = await prisma.letterboxdImport.findMany({ select: { userId: true } });
  const userIds = [...new Set(importUsers.map((u) => u.userId))];

  if (userIds.length === 0) {
    console.log(JSON.stringify({ message: "No Letterboxd import users found." }, null, 2));
    return;
  }

  const orphanMovies = await prisma.movie.findMany({
    where: {
      imdbId: null,
      tmdbId: null,
      traktSlug: null,
      ratings: { some: { userId: { in: userIds } } },
    },
    select: { id: true, title: true, year: true },
  });

  let rematched = 0;
  let merged = 0;
  let unresolved = 0;

  for (const movie of orphanMovies) {
    const variants = buildTitleVariants(movie.title);
    const normalizedTarget = normalizeTitle(movie.title);

    let best: { tmdb: any; score: number } | null = null;

    for (const variant of variants) {
      const results = await searchTMDB(variant, tmdb);
      for (const candidate of results.slice(0, 10)) {
        const candidateTitle = typeof candidate?.title === "string" ? candidate.title : "";
        const normalizedCandidate = normalizeTitle(candidateTitle);
        if (!normalizedCandidate) continue;

        const year = parseYearFromDate(candidate?.release_date);
        const yearDiff = movie.year !== null && year !== null ? Math.abs(movie.year - year) : null;

        let score = 0;
        if (normalizedCandidate === normalizedTarget) score += 100;
        else if (normalizedCandidate.startsWith(normalizedTarget) || normalizedTarget.startsWith(normalizedCandidate)) score += 80;

        if (yearDiff !== null) {
          if (yearDiff === 0) score += 40;
          else if (yearDiff === 1) score += 25;
          else if (yearDiff === 2) score += 10;
          else score -= 25;
        }

        score += Math.min(20, Math.log10((candidate?.vote_count ?? 0) + 1) * 5);
        score += Math.min(10, (candidate?.popularity ?? 0) / 20);

        if (!best || score > best.score) {
          best = { tmdb: candidate, score };
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 70));
    }

    if (!best || !best.tmdb?.id) {
      unresolved += 1;
      continue;
    }

    const bestYear = parseYearFromDate(best.tmdb.release_date);
    const titleMatch = normalizeTitle(best.tmdb.title || "") === normalizedTarget;
    const yearClose = movie.year !== null && bestYear !== null ? Math.abs(movie.year - bestYear) <= 1 : false;
    const confident = (titleMatch && (movie.year === null || yearClose)) || best.score >= 130;

    if (!confident) {
      unresolved += 1;
      continue;
    }

    const details = await getTMDBDetails(String(best.tmdb.id), tmdb);
    if (!details) {
      unresolved += 1;
      continue;
    }

    const imdbId = typeof details?.external_ids?.imdb_id === "string" ? details.external_ids.imdb_id : null;
    const tmdbId = String(best.tmdb.id);

    const existingCanonical = await prisma.movie.findFirst({
      where: {
        id: { not: movie.id },
        OR: [
          ...(imdbId ? [{ imdbId }] : []),
          { tmdbId },
        ],
      },
      select: { id: true },
    });

    if (existingCanonical) {
      await mergeMovieIntoTarget(movie.id, existingCanonical.id);
      merged += 1;
      continue;
    }

    await prisma.movie.update({
      where: { id: movie.id },
      data: {
        tmdbId,
        ...(imdbId ? { imdbId } : {}),
        title: details.title || movie.title,
        year: parseYearFromDate(details.release_date) ?? movie.year,
        ...(typeof details.overview === "string" && details.overview.trim() ? { overview: details.overview } : {}),
        ...(typeof details.runtime === "number" && details.runtime > 0 ? { runtime: details.runtime } : {}),
        ...(details.release_date ? { releaseDate: new Date(details.release_date) } : {}),
        ...(typeof details.vote_average === "number" ? { voteAverage: details.vote_average } : {}),
        ...(typeof details.vote_count === "number" ? { voteCount: details.vote_count } : {}),
        ...(typeof details.popularity === "number" ? { popularity: details.popularity } : {}),
      },
    });

    await upsertRelationsFromTMDB(movie.id, details);
    rematched += 1;

    await new Promise((resolve) => setTimeout(resolve, 70));
  }

  // Quarantine clearly malformed unresolved movies so they stop polluting ML training.
  const remainingOrphans = await prisma.movie.findMany({
    where: {
      imdbId: null,
      tmdbId: null,
      traktSlug: null,
      ratings: { some: { userId: { in: userIds } } },
    },
    select: { id: true, title: true, year: true },
  });

  let quarantinedRatings = 0;
  let deletedMalformedMovies = 0;

  for (const movie of remainingOrphans) {
    if (!isClearlyMalformedTitle(movie.title, movie.year)) continue;

    const nonImportRatings = await prisma.movieRating.count({
      where: {
        movieId: movie.id,
        userId: { notIn: userIds },
      },
    });

    if (nonImportRatings === 0) {
      await prisma.movie.delete({ where: { id: movie.id } });
      deletedMalformedMovies += 1;
      continue;
    }

    const update = await prisma.movieRating.updateMany({
      where: { movieId: movie.id, userId: { in: userIds } },
      data: { rating: null, notHeardOf: true, hasSeen: false },
    });
    quarantinedRatings += update.count;
  }

  // Backfill ML/recommendation-critical metadata on rated movies with TMDB IDs.
  const moviesToBackfill = await prisma.movie.findMany({
    where: {
      ratings: { some: { userId: { in: userIds } } },
      tmdbId: { not: null },
      OR: [
        { voteCount: null },
        { voteCount: { lte: 0 } },
        { voteAverage: null },
        { voteAverage: { lte: 0 } },
        { popularity: null },
        { runtime: null },
        { overview: null },
        { genres: { none: {} } },
        { cast: { none: {} } },
        { crew: { none: { job: "Director" } } },
        { studios: { none: {} } },
      ],
    },
    select: { id: true, tmdbId: true },
  });

  let metadataBackfilled = 0;
  for (const movie of moviesToBackfill) {
    if (!movie.tmdbId) continue;
    const details = await getTMDBDetails(movie.tmdbId, tmdb);
    if (!details) continue;

    const imdbId = typeof details?.external_ids?.imdb_id === "string" ? details.external_ids.imdb_id : null;

    await prisma.movie.update({
      where: { id: movie.id },
      data: {
        ...(imdbId ? { imdbId } : {}),
        ...(typeof details.overview === "string" && details.overview.trim() ? { overview: details.overview } : {}),
        ...(typeof details.runtime === "number" && details.runtime > 0 ? { runtime: details.runtime } : {}),
        ...(details.release_date ? { releaseDate: new Date(details.release_date) } : {}),
        ...(parseYearFromDate(details.release_date)
          ? { year: parseYearFromDate(details.release_date) }
          : {}),
        ...(typeof details.vote_average === "number" ? { voteAverage: details.vote_average } : {}),
        ...(typeof details.vote_count === "number" ? { voteCount: details.vote_count } : {}),
        ...(typeof details.popularity === "number" ? { popularity: details.popularity } : {}),
      },
    });

    await upsertRelationsFromTMDB(movie.id, details);
    metadataBackfilled += 1;

    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  const remainingRatingsWithoutIds = await prisma.movieRating.count({
    where: {
      userId: { in: userIds },
      rating: { not: null },
      notHeardOf: false,
      movie: { imdbId: null, tmdbId: null, traktSlug: null },
    },
  });

  const remainingMlCriticalMissing = await prisma.movie.count({
    where: {
      ratings: { some: { userId: { in: userIds } } },
      OR: [
        { voteCount: null },
        { voteCount: { lte: 0 } },
        { voteAverage: null },
        { voteAverage: { lte: 0 } },
        { genres: { none: {} } },
        { cast: { none: {} } },
        { crew: { none: { job: "Director" } } },
        { studios: { none: {} } },
      ],
    },
  });

  let retrained = false;
  try {
    if (await shouldRetrain()) {
      await trainMatrixFactorization();
      retrained = true;
    }
  } catch {
    // Non-fatal for remediation run
  }

  console.log(
    JSON.stringify(
      {
        importUsers: userIds.length,
        orphanScanned: orphanMovies.length,
        rematched,
        merged,
        unresolvedAfterMatchAttempt: unresolved,
        deletedMalformedMovies,
        quarantinedRatings,
        metadataBackfilled,
        remainingRatingsWithoutIds,
        remainingMlCriticalMissing,
        retrained,
      },
      null,
      2
    )
  );
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

