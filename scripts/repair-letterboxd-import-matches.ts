/* eslint-disable @typescript-eslint/no-explicit-any */
import { PrismaClient, type Movie } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const connectionString = "postgresql://movienight:movienight@127.0.0.1:5432/movienight?schema=public";
const pool = new pg.Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const TRAKT_BASE = "https://api.trakt.tv";

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function movieKnownnessScore(movie: {
  voteCount: number | null;
  popularity: number | null;
}): number {
  return (movie.voteCount ?? 0) * 2 + (movie.popularity ?? 0);
}

async function mergeMovieIntoTarget(sourceMovieId: string, targetMovieId: string): Promise<{ moved: number; removed: number }> {
  if (sourceMovieId === targetMovieId) return { moved: 0, removed: 0 };

  const sourceRatings = await prisma.movieRating.findMany({
    where: { movieId: sourceMovieId },
    select: { id: true, userId: true, rating: true, hasSeen: true, notHeardOf: true },
  });

  let moved = 0;
  let removed = 0;

  for (const rating of sourceRatings) {
    const existing = await prisma.movieRating.findUnique({
      where: {
        userId_movieId: {
          userId: rating.userId,
          movieId: targetMovieId,
        },
      },
    });

    if (!existing) {
      await prisma.movieRating.update({
        where: { id: rating.id },
        data: { movieId: targetMovieId },
      });
      moved += 1;
      continue;
    }

    const mergedRating = existing.rating ?? rating.rating;
    const mergedHasSeen = existing.hasSeen || rating.hasSeen;
    const mergedNotHeardOf = mergedRating === null ? existing.notHeardOf && rating.notHeardOf : false;

    await prisma.movieRating.update({
      where: { id: existing.id },
      data: {
        rating: mergedRating,
        hasSeen: mergedHasSeen,
        notHeardOf: mergedNotHeardOf,
      },
    });

    await prisma.movieRating.delete({ where: { id: rating.id } });
    removed += 1;
  }

  const remainingRefs = await Promise.all([
    prisma.movieRating.count({ where: { movieId: sourceMovieId } }),
    prisma.sessionMovie.count({ where: { movieId: sourceMovieId } }),
    prisma.movieGenre.count({ where: { movieId: sourceMovieId } }),
    prisma.movieStudio.count({ where: { movieId: sourceMovieId } }),
    prisma.movieCast.count({ where: { movieId: sourceMovieId } }),
    prisma.movieCrew.count({ where: { movieId: sourceMovieId } }),
    prisma.radarrSync.count({ where: { movieId: sourceMovieId } }),
    prisma.plexAvailability.count({ where: { movieId: sourceMovieId } }),
  ]);

  const totalRefs = remainingRefs.reduce((sum, count) => sum + count, 0);
  if (totalRefs === 0) {
    await prisma.movie.delete({ where: { id: sourceMovieId } });
  }

  return { moved, removed };
}

function parseReleaseYear(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const match = dateStr.match(/^(\d{4})/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isNaN(parsed) ? null : parsed;
}

async function getTraktApiKey(): Promise<string | null> {
  const config = await prisma.integrationConfig.findUnique({
    where: { service: "trakt" },
    select: { enabled: true, apiKey: true },
  });

  if (config?.enabled && config.apiKey) return config.apiKey;
  return process.env.TRAKT_CLIENT_ID ?? null;
}

async function searchTrakt(query: string, apiKey: string) {
  const res = await fetch(`${TRAKT_BASE}/search/movie?query=${encodeURIComponent(query)}`, {
    headers: {
      "Content-Type": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": apiKey,
    },
  });

  if (!res.ok) return [] as any[];
  const data = await res.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}

async function main() {
  const importUsers = await prisma.letterboxdImport.findMany({ select: { userId: true } });
  const userIds = [...new Set(importUsers.map((u) => u.userId))];

  if (userIds.length === 0) {
    console.log("No Letterboxd import users found.");
    return;
  }

  const orphanMovies = await prisma.movie.findMany({
    where: {
      imdbId: null,
      tmdbId: null,
      traktSlug: null,
      ratings: {
        some: { userId: { in: userIds } },
      },
    },
    select: {
      id: true,
      title: true,
      year: true,
      voteCount: true,
      popularity: true,
    },
  });

  const canonicalMovies = await prisma.movie.findMany({
    where: {
      OR: [{ imdbId: { not: null } }, { tmdbId: { not: null } }, { traktSlug: { not: null } }],
    },
    select: {
      id: true,
      title: true,
      year: true,
      imdbId: true,
      tmdbId: true,
      traktSlug: true,
      voteCount: true,
      popularity: true,
      posterUrl: true,
      overview: true,
      runtime: true,
      releaseDate: true,
    },
  });

  const byNorm = new Map<string, typeof canonicalMovies>();
  for (const movie of canonicalMovies) {
    const norm = normalizeTitle(movie.title);
    if (!norm) continue;
    if (!byNorm.has(norm)) byNorm.set(norm, [] as any);
    byNorm.get(norm)!.push(movie as any);
  }

  let localMerged = 0;
  let localAmbiguous = 0;
  let sourceUpdatedFromTrakt = 0;
  let sourceMergedToExistingByTraktId = 0;
  let unresolved = 0;

  const traktKey = await getTraktApiKey();

  for (const orphan of orphanMovies) {
    const norm = normalizeTitle(orphan.title);
    if (!norm) {
      unresolved += 1;
      continue;
    }

    const localCandidates = (byNorm.get(norm) ?? []).filter((candidate) => {
      if (orphan.year === null || candidate.year === null) return false;
      return Math.abs(candidate.year - orphan.year) <= 1;
    });

    if (localCandidates.length > 0) {
      localCandidates.sort((a, b) => {
        const diffA = Math.abs((a.year ?? 0) - (orphan.year ?? 0));
        const diffB = Math.abs((b.year ?? 0) - (orphan.year ?? 0));
        if (diffA !== diffB) return diffA - diffB;
        return movieKnownnessScore(b) - movieKnownnessScore(a);
      });

      const best = localCandidates[0];
      const bestDiff = Math.abs((best.year ?? 0) - (orphan.year ?? 0));
      const equallyGood = localCandidates.filter((candidate) => {
        const diff = Math.abs((candidate.year ?? 0) - (orphan.year ?? 0));
        return diff === bestDiff;
      });

      if (equallyGood.length === 1) {
        await mergeMovieIntoTarget(orphan.id, best.id);
        localMerged += 1;
        continue;
      }

      localAmbiguous += 1;
    }

    if (!traktKey || orphan.year === null) {
      unresolved += 1;
      continue;
    }

    const traktResults = await searchTrakt(orphan.title, traktKey);
    const filtered = traktResults
      .map((item) => item?.movie)
      .filter((movie) => movie && typeof movie.title === "string")
      .filter((movie) => normalizeTitle(movie.title) === norm)
      .filter((movie) => {
        if (typeof movie.year !== "number") return false;
        return Math.abs(movie.year - orphan.year!) <= 1;
      });

    if (filtered.length === 0) {
      unresolved += 1;
      continue;
    }

    filtered.sort((a, b) => {
      const yearDiffA = Math.abs((a.year ?? 0) - orphan.year!);
      const yearDiffB = Math.abs((b.year ?? 0) - orphan.year!);
      if (yearDiffA !== yearDiffB) return yearDiffA - yearDiffB;
      const votesA = typeof a.votes === "number" ? a.votes : 0;
      const votesB = typeof b.votes === "number" ? b.votes : 0;
      return votesB - votesA;
    });

    const best = filtered[0];
    const ids = best.ids ?? {};
    const imdbId = typeof ids.imdb === "string" ? ids.imdb : null;
    const tmdbId = ids.tmdb ? String(ids.tmdb) : null;
    const traktSlug = typeof ids.slug === "string" ? ids.slug : null;

    if (!imdbId && !tmdbId && !traktSlug) {
      unresolved += 1;
      continue;
    }

    const existingByIds = await prisma.movie.findFirst({
      where: {
        id: { not: orphan.id },
        OR: [
          ...(imdbId ? [{ imdbId }] : []),
          ...(tmdbId ? [{ tmdbId }] : []),
          ...(traktSlug ? [{ traktSlug }] : []),
        ],
      },
      select: { id: true },
    });

    if (existingByIds) {
      await mergeMovieIntoTarget(orphan.id, existingByIds.id);
      sourceMergedToExistingByTraktId += 1;
      continue;
    }

    await prisma.movie.update({
      where: { id: orphan.id },
      data: {
        ...(imdbId ? { imdbId } : {}),
        ...(tmdbId ? { tmdbId } : {}),
        ...(traktSlug ? { traktSlug } : {}),
        title: best.title ?? orphan.title,
        year: typeof best.year === "number" ? best.year : orphan.year,
        ...(typeof best.runtime === "number" ? { runtime: best.runtime } : {}),
        ...(typeof best.overview === "string" && best.overview.trim()
          ? { overview: best.overview }
          : {}),
        ...(typeof best.rating === "number" ? { voteAverage: Math.max(0, Math.min(10, best.rating)) } : {}),
        ...(typeof best.votes === "number" ? { voteCount: best.votes } : {}),
        ...(best.released ? { releaseDate: new Date(best.released) } : {}),
        ...(typeof best.released === "string"
          ? {
              year: parseReleaseYear(best.released) ?? (typeof best.year === "number" ? best.year : orphan.year),
            }
          : {}),
      },
    });

    sourceUpdatedFromTrakt += 1;

    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  const postMissing = await prisma.movieRating.count({
    where: {
      userId: { in: userIds },
      movie: { imdbId: null, tmdbId: null, traktSlug: null },
    },
  });

  console.log(
    JSON.stringify(
      {
        importUsers: userIds.length,
        orphanMoviesScanned: orphanMovies.length,
        localMerged,
        localAmbiguous,
        sourceUpdatedFromTrakt,
        sourceMergedToExistingByTraktId,
        unresolved,
        remainingRatingsWithoutIds: postMissing,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

