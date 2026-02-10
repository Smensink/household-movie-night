import { prisma } from "@/lib/prisma";

const MAX_TAGS_PER_MOVIE = 15;
const MIN_RATINGS_FOR_AVG = 10;

/**
 * Backfill MovieLens data (tags + average rating) for a newly added movie.
 * Reads from cached MLTagData and MLRating tables (no network calls).
 * Safe to call even if no ML data exists for the movie.
 */
export async function backfillMLDataForMovie(
  movieId: string,
  imdbId: string
): Promise<void> {
  try {
    // Tags: top 15 from MLTagData by relevance
    const mlTags = await prisma.mLTagData.findMany({
      where: { imdbId },
      orderBy: { relevance: "desc" },
      take: MAX_TAGS_PER_MOVIE,
    });

    if (mlTags.length > 0) {
      await prisma.movieTag.createMany({
        data: mlTags.map((t) => ({
          movieId,
          tag: t.tag,
          relevance: t.relevance,
        })),
        skipDuplicates: true,
      });
    }

    // Average rating from MLRating
    const agg = await prisma.mLRating.aggregate({
      where: { imdbId },
      _avg: { rating: true },
      _count: { rating: true },
    });

    if (agg._count.rating >= MIN_RATINGS_FOR_AVG && agg._avg.rating != null) {
      await prisma.movie.update({
        where: { id: movieId },
        data: { letterboxdRating: agg._avg.rating },
      });
    }
  } catch (error) {
    // Non-critical — log but don't fail movie creation
    console.error(
      `[ML Backfill] Error backfilling movie ${movieId} (${imdbId}):`,
      error
    );
  }
}
