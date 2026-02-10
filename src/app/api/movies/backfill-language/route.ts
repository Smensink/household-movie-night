import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTMDBMovie } from "@/lib/api/tmdb";
import { isInternalOrAdmin } from "@/lib/internal-auth";

const BATCH_SIZE = 100;

/**
 * POST /api/movies/backfill-language
 * Backfill originalLanguage and originCountry from TMDB for movies missing them.
 */
export async function POST(req: NextRequest) {
  if (!(await isInternalOrAdmin(req))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  console.log("[Language Backfill] Starting language/country backfill from TMDB...");

  const movies = await prisma.movie.findMany({
    where: {
      isMlOnly: false,
      tmdbId: { not: null },
      originalLanguage: null,
    },
    select: { id: true, tmdbId: true, title: true },
    take: BATCH_SIZE,
    orderBy: { updatedAt: "asc" },
  });

  if (movies.length === 0) {
    return NextResponse.json({ message: "No movies need backfill", updated: 0 });
  }

  let updated = 0;
  let failed = 0;

  for (const movie of movies) {
    try {
      const tmdb = await getTMDBMovie(movie.tmdbId!);
      if (!tmdb) {
        failed++;
        continue;
      }

      const data: { originalLanguage?: string; originCountry?: string } = {};
      if (tmdb.original_language) {
        data.originalLanguage = tmdb.original_language;
      }
      if (tmdb.origin_country && tmdb.origin_country.length > 0) {
        data.originCountry = tmdb.origin_country[0];
      }

      if (Object.keys(data).length > 0) {
        await prisma.movie.update({
          where: { id: movie.id },
          data,
        });
        updated++;
      }
    } catch (err) {
      console.error(`[Language Backfill] Failed for ${movie.title}:`, err);
      failed++;
    }
  }

  const remaining = await prisma.movie.count({
    where: { isMlOnly: false, tmdbId: { not: null }, originalLanguage: null },
  });

  console.log(`[Language Backfill] Updated ${updated}, failed ${failed}, remaining ${remaining}`);

  return NextResponse.json({
    message: `Updated ${updated} movies, ${failed} failed, ${remaining} remaining`,
    updated,
    failed,
    remaining,
    batchSize: BATCH_SIZE,
  });
}
