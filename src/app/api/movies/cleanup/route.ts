import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTMDBMovie } from "@/lib/api/tmdb";
import { getOMDBMovie, extractRatingsFromOMDB } from "@/lib/api/omdb";

const BATCH_SIZE = 50; // Process 50 movies per request
const MIN_VOTE_COUNT = 500; // Minimum votes for older movies
const MIN_VOTE_COUNT_RECENT = 100; // Minimum votes for movies < 6 months old
const RECENT_MOVIE_MONTHS = 6; // Movies released in last 6 months get lower threshold

/**
 * POST /api/movies/cleanup
 * Fetches vote counts and removes movies that don't meet the recognition threshold.
 * This keeps the database focused on movies people would actually recognize.
 */
export async function POST() {
  console.log("[Movie Cleanup] Starting vote count fetch and cleanup...");

  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - RECENT_MOVIE_MONTHS);
  const currentYear = new Date().getFullYear();

  // Find movies that need vote count data OR have low vote counts
  const movies = await prisma.movie.findMany({
    where: {
      OR: [
        { tmdbId: { not: null } },
        { imdbId: { not: null } },
      ],
    },
    select: {
      id: true,
      tmdbId: true,
      imdbId: true,
      title: true,
      year: true,
      releaseDate: true,
      voteCount: true,
      // Check if movie has any user ratings (don't delete if users have rated it)
      _count: {
        select: { ratings: true },
      },
    },
    orderBy: { voteCount: "asc" }, // Process lowest vote counts first
    take: BATCH_SIZE,
  });

  let updated = 0;
  let deleted = 0;
  let kept = 0;
  let errors = 0;

  for (const movie of movies) {
    try {
      let voteCount = movie.voteCount ?? 0;

      // Fetch vote count if we don't have it or it's 0
      if (voteCount === 0) {
        let tmdbVoteCount = 0;
        let imdbVotes = 0;

        if (movie.tmdbId) {
          const tmdbMovie = await getTMDBMovie(parseInt(movie.tmdbId, 10));
          if (tmdbMovie) {
            tmdbVoteCount = tmdbMovie.vote_count ?? 0;
            // Update other metadata too
            await prisma.movie.update({
              where: { id: movie.id },
              data: {
                voteCount: tmdbMovie.vote_count ?? 0,
                voteAverage: tmdbMovie.vote_average ?? undefined,
                popularity: tmdbMovie.popularity ?? undefined,
              },
            });
          }
        }

        if (movie.imdbId) {
          const omdbMovie = await getOMDBMovie(movie.imdbId);
          if (omdbMovie) {
            const extracted = extractRatingsFromOMDB(omdbMovie);
            imdbVotes = extracted.imdbVotes ?? 0;
            if (imdbVotes > 0) {
              await prisma.movie.update({
                where: { id: movie.id },
                data: { imdbVotes },
              });
            }
          }
        }

        voteCount = Math.max(tmdbVoteCount, imdbVotes);
        updated++;
      }

      // Determine if movie is "recent" (less than 6 months old)
      const isRecent =
        (movie.releaseDate && movie.releaseDate > sixMonthsAgo) ||
        (movie.year && movie.year >= currentYear);

      const threshold = isRecent ? MIN_VOTE_COUNT_RECENT : MIN_VOTE_COUNT;

      // Don't delete if:
      // 1. Movie has user ratings
      // 2. Vote count meets threshold
      // 3. Vote count is still unknown (0) - give it another chance
      if (movie._count.ratings > 0) {
        kept++;
        continue;
      }

      if (voteCount === 0) {
        // Haven't fetched votes yet, skip deletion
        kept++;
        continue;
      }

      if (voteCount >= threshold) {
        kept++;
        continue;
      }

      // Delete obscure movie
      await prisma.movie.delete({ where: { id: movie.id } });
      deleted++;
      console.log(`[Movie Cleanup] Deleted: "${movie.title}" (${voteCount} votes, threshold: ${threshold})`);
    } catch (error) {
      errors++;
    }
  }

  // Count remaining movies that might need cleanup
  const remaining = await prisma.movie.count({
    where: {
      voteCount: { gt: 0, lt: MIN_VOTE_COUNT },
      ratings: { none: {} }, // No user ratings
    },
  });

  console.log(`[Movie Cleanup] Complete: ${updated} updated, ${deleted} deleted, ${kept} kept, ${errors} errors`);

  return NextResponse.json({
    message: `Cleanup complete: ${deleted} obscure movies removed`,
    updated,
    deleted,
    kept,
    errors,
    remainingBelowThreshold: remaining,
  });
}

/**
 * GET /api/movies/cleanup
 * Check status of movies below threshold
 */
export async function GET() {
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - RECENT_MOVIE_MONTHS);

  const [total, belowThreshold, noVoteData, withUserRatings] = await Promise.all([
    prisma.movie.count(),
    prisma.movie.count({
      where: {
        voteCount: { gt: 0, lt: MIN_VOTE_COUNT },
        ratings: { none: {} },
      },
    }),
    prisma.movie.count({
      where: {
        OR: [
          { voteCount: null },
          { voteCount: 0 },
        ],
      },
    }),
    prisma.movie.count({
      where: {
        ratings: { some: {} },
      },
    }),
  ]);

  return NextResponse.json({
    total,
    belowThreshold,
    noVoteData,
    withUserRatings,
    thresholds: {
      standard: MIN_VOTE_COUNT,
      recent: MIN_VOTE_COUNT_RECENT,
    },
  });
}
