import { NextResponse } from "next/server";
import { getBoxOfficeMovies, getPopularMovies, getTrendingMovies, getTraktMovieRatings } from "@/lib/api/trakt";
import { getOMDBMovie, getHighResPosterUrl, extractRatingsFromOMDB } from "@/lib/api/omdb";
import { getTMDBMovieByImdbId, extractTMDBRating } from "@/lib/api/tmdb";
import { prisma } from "@/lib/prisma";
import { syncMovieMetadataFromOMDB } from "@/lib/movie-metadata";

const PREFILL_LIMIT = 500;

function parseOptionalInt(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/\d+/);
  if (!match) return null;
  const parsed = Number.parseInt(match[0], 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function getEra(year: number | null): string | null {
  if (!year) return null;
  const currentYear = new Date().getFullYear();
  if (year >= currentYear - 1) return "new_release";
  if (year >= 2000) return "modern_classic";
  return "classic";
}

export async function POST() {
  console.log("[Movie Prefill] Starting movie prefill...");

  // Check how many movies we already have
  const existingCount = await prisma.movie.count();

  // If we already have enough movies, skip prefill
  if (existingCount >= PREFILL_LIMIT) {
    console.log(`[Movie Prefill] Already have ${existingCount} movies, skipping`);
    return NextResponse.json({
      message: "Database already has sufficient movies",
      existingCount,
      added: 0,
    });
  }

  const [trending, popular, boxOffice] = await Promise.all([
    getTrendingMovies(100),
    getPopularMovies(200),
    getBoxOfficeMovies(),
  ]);

  const traktMovies = [
    ...trending.map((item) => item.movie),
    ...popular,
    ...boxOffice.map((item) => item.movie),
  ];

  // Dedupe by IMDB ID
  const seenImdbIds = new Set<string>();
  const uniqueMovies: typeof traktMovies = [];
  for (const movie of traktMovies) {
    const imdbId = movie.ids?.imdb;
    if (!imdbId || seenImdbIds.has(imdbId)) continue;
    seenImdbIds.add(imdbId);
    uniqueMovies.push(movie);
  }

  let added = 0;
  const toProcess = uniqueMovies.slice(0, PREFILL_LIMIT - existingCount);

  for (const movie of toProcess) {
    const imdbId = movie.ids?.imdb;
    if (!imdbId) continue;

    // Check if already exists
    const existing = await prisma.movie.findUnique({
      where: { imdbId },
      select: { id: true, posterUrl: true },
    });

    if (existing) continue;

    // Fetch OMDB details for metadata
    const details = await getOMDBMovie(imdbId);
    if (!details) continue;

    const year = movie.year || parseOptionalInt(details.Year) || null;
    const runtime = parseOptionalInt(details.Runtime) || null;
    const era = getEra(year);
    const posterUrl = getHighResPosterUrl(details.Poster);

    // Get ratings with fallback sources
    let imdbRating: number | null = null;
    let rottenTomatoesAudience: number | null = null;

    // 1. Try OMDB
    const omdbRatings = extractRatingsFromOMDB(details);
    imdbRating = omdbRatings.imdbRating;
    rottenTomatoesAudience = omdbRatings.rottenTomatoesAudience;

    // 2. Fallback to Trakt for rating
    if (!imdbRating) {
      const traktRatings = await getTraktMovieRatings(imdbId);
      if (traktRatings?.rating && traktRatings.rating > 0) {
        imdbRating = Math.round(traktRatings.rating * 10) / 10;
      }
    }

    // 3. Fallback to TMDB for rating
    if (!imdbRating) {
      const tmdbMovie = await getTMDBMovieByImdbId(imdbId);
      const tmdbRating = extractTMDBRating(tmdbMovie);
      if (tmdbRating) {
        imdbRating = tmdbRating;
      }
    }

    try {
      const created = await prisma.movie.create({
        data: {
          imdbId,
          tmdbId: movie.ids?.tmdb?.toString() || null,
          traktSlug: movie.ids?.slug || null,
          title: movie.title,
          year,
          posterUrl,
          overview: details.Plot || null,
          runtime,
          era,
          imdbRating,
          rottenTomatoesAudience,
        },
        select: { id: true },
      });

      // Sync cast, crew, studios, genres (wrapped in try-catch to handle constraint errors)
      try {
        await syncMovieMetadataFromOMDB(created.id, details);
      } catch {
        // Ignore metadata sync errors - movie is still created
      }
      added++;
    } catch {
      // Skip if insert fails (e.g., duplicate)
    }
  }

  console.log(`[Movie Prefill] Complete: added ${added} movies (total: ${existingCount + added})`);

  return NextResponse.json({
    message: `Prefilled ${added} movies`,
    existingCount,
    added,
    total: existingCount + added,
  });
}

export async function GET() {
  const count = await prisma.movie.count();
  const moviesWithPosters = await prisma.movie.count({
    where: { posterUrl: { not: null } },
  });

  return NextResponse.json({
    totalMovies: count,
    moviesWithPosters,
    needsPrefill: count < PREFILL_LIMIT,
  });
}

// PATCH - Upgrade existing movies: high-res posters and backfill ratings
export async function PATCH() {
  console.log("[Movie Prefill] Starting poster upgrade and ratings backfill...");

  // 1. Upgrade low-res poster URLs
  const moviesWithLowResPosters = await prisma.movie.findMany({
    where: {
      posterUrl: {
        contains: "SX300",
      },
    },
    select: { id: true, posterUrl: true },
  });

  let postersUpgraded = 0;
  for (const movie of moviesWithLowResPosters) {
    if (!movie.posterUrl) continue;
    const highRes = getHighResPosterUrl(movie.posterUrl);
    if (highRes && highRes !== movie.posterUrl) {
      await prisma.movie.update({
        where: { id: movie.id },
        data: { posterUrl: highRes },
      });
      postersUpgraded++;
    }
  }

  // 2. Backfill ratings for movies missing them
  const moviesWithoutRatings = await prisma.movie.findMany({
    where: {
      imdbId: { not: null },
      imdbRating: null,
    },
    select: { id: true, imdbId: true },
    take: 50, // Limit to avoid timeout
  });

  let ratingsUpdated = 0;
  for (const movie of moviesWithoutRatings) {
    if (!movie.imdbId) continue;

    try {
      let imdbRating: number | null = null;
      let rottenTomatoesAudience: number | null = null;

      // 1. Try OMDB first
      const omdbDetails = await getOMDBMovie(movie.imdbId);
      if (omdbDetails) {
        const omdbRatings = extractRatingsFromOMDB(omdbDetails);
        imdbRating = omdbRatings.imdbRating;
        rottenTomatoesAudience = omdbRatings.rottenTomatoesAudience;
      }

      // 2. If no IMDB rating, try Trakt
      if (!imdbRating) {
        const traktRatings = await getTraktMovieRatings(movie.imdbId);
        if (traktRatings?.rating && traktRatings.rating > 0) {
          // Trakt is on 0-10 scale
          imdbRating = Math.round(traktRatings.rating * 10) / 10;
        }
      }

      // 3. If still no rating, try TMDB
      if (!imdbRating) {
        const tmdbMovie = await getTMDBMovieByImdbId(movie.imdbId);
        const tmdbRating = extractTMDBRating(tmdbMovie);
        if (tmdbRating) {
          imdbRating = tmdbRating;
        }
      }

      if (imdbRating || rottenTomatoesAudience) {
        await prisma.movie.update({
          where: { id: movie.id },
          data: {
            ...(imdbRating && { imdbRating }),
            ...(rottenTomatoesAudience && { rottenTomatoesAudience }),
          },
        });
        ratingsUpdated++;
      }
    } catch {
      // Skip on error
    }
  }

  console.log(`[Movie Prefill] Upgrade complete: ${postersUpgraded} posters, ${ratingsUpdated} ratings`);

  return NextResponse.json({
    message: `Upgraded ${postersUpgraded} posters, backfilled ${ratingsUpdated} ratings`,
    postersUpgraded,
    postersChecked: moviesWithLowResPosters.length,
    ratingsUpdated,
    ratingsChecked: moviesWithoutRatings.length,
  });
}
