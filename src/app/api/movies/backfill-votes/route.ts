import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTMDBMovie } from "@/lib/api/tmdb";
import { getOMDBMovie, extractRatingsFromOMDB } from "@/lib/api/omdb";
import { isInternalOrAdmin } from "@/lib/internal-auth";

const BATCH_SIZE = 100; // Process 100 movies per request to avoid timeout

/**
 * POST /api/movies/backfill-votes
 * Backfill vote counts from TMDB and OMDB (IMDb votes).
 * Uses the maximum vote count from either source.
 * This helps filter out obscure movies that few people have seen.
 */
export async function POST(req: NextRequest) {
  if (!(await isInternalOrAdmin(req))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  console.log("[Vote Backfill] Starting vote count backfill from TMDB/OMDB...");

  // Find movies with TMDB ID but no vote count data
  const movies = await prisma.movie.findMany({
    where: {
      OR: [
        { tmdbId: { not: null } },
        { imdbId: { not: null } },
      ],
      AND: [
        {
          OR: [
            { voteCount: null },
            { voteCount: 0 },
          ],
        },
      ],
    },
    select: {
      id: true,
      tmdbId: true,
      imdbId: true,
      title: true,
    },
    take: BATCH_SIZE,
  });

  if (movies.length === 0) {
    console.log("[Vote Backfill] No movies need backfill");
    return NextResponse.json({
      message: "All movies already have vote count data",
      updated: 0,
      remaining: 0,
    });
  }

  let updated = 0;
  let errors = 0;

  for (const movie of movies) {
    try {
      let tmdbVoteCount = 0;
      let tmdbVoteAverage = 0;
      let tmdbPopularity = 0;
      let imdbVotes = 0;

      // Try TMDB first
      if (movie.tmdbId) {
        const tmdbMovie = await getTMDBMovie(parseInt(movie.tmdbId, 10));
        if (tmdbMovie) {
          tmdbVoteCount = tmdbMovie.vote_count ?? 0;
          tmdbVoteAverage = tmdbMovie.vote_average ?? 0;
          tmdbPopularity = tmdbMovie.popularity ?? 0;
        }
      }

      // Also try OMDB for IMDb votes
      if (movie.imdbId) {
        const omdbMovie = await getOMDBMovie(movie.imdbId);
        if (omdbMovie) {
          const extracted = extractRatingsFromOMDB(omdbMovie);
          imdbVotes = extracted.imdbVotes ?? 0;
        }
      }

      // Use the maximum vote count from either source
      const bestVoteCount = Math.max(tmdbVoteCount, imdbVotes);

      if (bestVoteCount > 0 || tmdbVoteAverage > 0) {
        await prisma.movie.update({
          where: { id: movie.id },
          data: {
            voteCount: bestVoteCount,
            imdbVotes: imdbVotes > 0 ? imdbVotes : undefined,
            voteAverage: tmdbVoteAverage > 0 ? tmdbVoteAverage : undefined,
            popularity: tmdbPopularity > 0 ? tmdbPopularity : undefined,
          },
        });
        updated++;
      }
    } catch {
      errors++;
    }
  }

  // Count remaining movies that still need backfill
  const remaining = await prisma.movie.count({
    where: {
      OR: [
        { tmdbId: { not: null } },
        { imdbId: { not: null } },
      ],
      AND: [
        {
          OR: [
            { voteCount: null },
            { voteCount: 0 },
          ],
        },
      ],
    },
  });

  console.log(`[Vote Backfill] Complete: ${updated} updated, ${errors} errors, ${remaining} remaining`);

  return NextResponse.json({
    message: `Updated ${updated} movies with vote counts`,
    updated,
    errors,
    remaining,
    needsMoreRuns: remaining > 0,
  });
}

/**
 * GET /api/movies/backfill-votes
 * Check status of vote count data
 */
export async function GET(req: NextRequest) {
  if (!(await isInternalOrAdmin(req))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const [total, withVoteCount, withoutVoteCount] = await Promise.all([
    prisma.movie.count(),
    prisma.movie.count({
      where: {
        voteCount: { gt: 0 },
      },
    }),
    prisma.movie.count({
      where: {
        tmdbId: { not: null },
        OR: [
          { voteCount: null },
          { voteCount: 0 },
        ],
      },
    }),
  ]);

  // Get distribution of vote counts
  const distribution = await prisma.movie.groupBy({
    by: ["voteCount"],
    _count: true,
    where: {
      voteCount: { gt: 0 },
    },
    orderBy: {
      voteCount: "desc",
    },
    take: 10,
  });

  return NextResponse.json({
    total,
    withVoteCount,
    withoutVoteCount,
    needsBackfill: withoutVoteCount > 0,
    topVoteCounts: distribution.map((d) => ({
      voteCount: d.voteCount,
      movieCount: d._count,
    })),
  });
}
