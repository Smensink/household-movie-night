import { prisma } from "./prisma";
import { backfillMLDataForMovie } from "./ml-backfill";
import { getTrendingMovies, getPopularMovies, getAnticipatedMovies } from "./api/trakt";
import { getOMDBMovie, getHighResPosterUrl, extractRatingsFromOMDB } from "./api/omdb";
import {
  getTMDBMovie,
  getTMDBMovieByImdbId,
  getTMDBPosterUrl,
  extractTMDBRating,
} from "./api/tmdb";

const EXPANSION_THRESHOLD = 50; // Trigger expansion when user has fewer than this many unrated movies
const EXPANSION_BATCH_SIZE = 30; // How many movies to add per expansion
const EXPANSION_COOLDOWN_MS = 5 * 60_000; // Only expand every 5 minutes per user
const ANTICIPATED_EXPANSION_PAGES = 8;

// Track last expansion time per user
const expansionCooldowns = new Map<string, number>();
let anticipatedPageCursor = 1;

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

function parseDateOrNull(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Check how many unrated movies are available for a user
 */
export async function getUnratedMovieCount(userId: string): Promise<number> {
  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();

  const count = await prisma.movie.count({
    where: {
      posterUrl: { not: null },
      OR: [
        { releaseDate: { lte: currentDate } },
        { releaseDate: null, year: { lte: currentYear } },
      ],
      ratings: {
        none: { userId },
      },
    },
  });

  return count;
}

/**
 * Check if the movie pool should be expanded for a user
 */
export async function shouldExpandPool(userId: string): Promise<boolean> {
  // Check cooldown
  const lastExpansion = expansionCooldowns.get(userId);
  if (lastExpansion && Date.now() - lastExpansion < EXPANSION_COOLDOWN_MS) {
    return false;
  }

  const unratedCount = await getUnratedMovieCount(userId);
  return unratedCount < EXPANSION_THRESHOLD;
}

/**
 * Expand the movie pool by fetching more movies from external sources
 * This runs in the background and doesn't block the request
 */
export async function expandMoviePool(): Promise<{
  added: number;
  skipped: number;
  source: string;
}> {
  console.log("[Pool Expansion] Fetching more movies from Trakt...");

  // Rotate anticipated pages so expansion can discover deeper upcoming titles over time.
  const anticipatedPage = anticipatedPageCursor;
  anticipatedPageCursor =
    anticipatedPageCursor >= ANTICIPATED_EXPANSION_PAGES ? 1 : anticipatedPageCursor + 1;

  // Get movies from multiple sources
  const [trending, popular, anticipated] = await Promise.all([
    getTrendingMovies(EXPANSION_BATCH_SIZE),
    getPopularMovies(EXPANSION_BATCH_SIZE),
    getAnticipatedMovies(EXPANSION_BATCH_SIZE, anticipatedPage),
  ]);

  const allMovies = [
    ...trending.map((t) => t.movie),
    ...popular,
    ...anticipated.map((a) => a.movie),
  ];

  // Dedupe by available external IDs so upcoming movies without IMDB IDs are still considered.
  const seenExternalIds = new Set<string>();
  const uniqueMovies: typeof allMovies = [];
  for (const movie of allMovies) {
    const imdbId = movie.ids?.imdb?.trim();
    const tmdbId = movie.ids?.tmdb ? String(movie.ids.tmdb) : null;
    const traktSlug = movie.ids?.slug?.trim() || null;
    const dedupeKey = imdbId
      ? `imdb:${imdbId}`
      : tmdbId
      ? `tmdb:${tmdbId}`
      : traktSlug
      ? `slug:${traktSlug}`
      : null;

    if (!dedupeKey || seenExternalIds.has(dedupeKey)) continue;
    seenExternalIds.add(dedupeKey);
    uniqueMovies.push(movie);
  }

  let added = 0;
  let skipped = 0;

  for (const movie of uniqueMovies.slice(0, EXPANSION_BATCH_SIZE)) {
    const imdbId = movie.ids?.imdb?.trim() || null;
    const tmdbId = movie.ids?.tmdb ? String(movie.ids.tmdb) : null;
    const traktSlug = movie.ids?.slug?.trim() || null;

    // Check if already exists
    const existingIdClauses = [
      ...(imdbId ? [{ imdbId }] : []),
      ...(tmdbId ? [{ tmdbId }] : []),
      ...(traktSlug ? [{ traktSlug }] : []),
    ];

    const existing =
      existingIdClauses.length > 0
        ? await prisma.movie.findFirst({
            where: { OR: existingIdClauses },
            select: { id: true },
          })
        : null;

    if (existing) {
      skipped++;
      continue;
    }

    const details = imdbId ? await getOMDBMovie(imdbId) : null;
    const tmdbMovie = tmdbId
      ? await getTMDBMovie(tmdbId)
      : imdbId
      ? await getTMDBMovieByImdbId(imdbId)
      : null;

    if (!details && !tmdbMovie) {
      skipped++;
      continue;
    }

    const tmdbReleaseYear = tmdbMovie?.release_date
      ? Number.parseInt(tmdbMovie.release_date.slice(0, 4), 10)
      : null;
    const year =
      movie.year ||
      parseOptionalInt(details?.Year) ||
      (tmdbReleaseYear && !Number.isNaN(tmdbReleaseYear) ? tmdbReleaseYear : null);
    const runtime = parseOptionalInt(details?.Runtime) || tmdbMovie?.runtime || null;
    const era = getEra(year);
    const releaseDate = parseDateOrNull(tmdbMovie?.release_date);
    const omdbPoster = getHighResPosterUrl(details?.Poster);
    const tmdbPoster = tmdbMovie?.poster_path
      ? getTMDBPosterUrl(tmdbMovie.poster_path, "w780")
      : null;
    const posterUrl = omdbPoster || tmdbPoster || null;
    const overview = details?.Plot || tmdbMovie?.overview || null;

    // Get ratings with fallback sources
    let imdbRating: number | null = null;
    let rottenTomatoesAudience: number | null = null;

    if (details) {
      const omdbRatings = extractRatingsFromOMDB(details);
      imdbRating = omdbRatings.imdbRating;
      rottenTomatoesAudience = omdbRatings.rottenTomatoesAudience;
    }

    // Fallback to TMDB for rating if needed
    if (!imdbRating) {
      const tmdbRating = extractTMDBRating(tmdbMovie);
      if (tmdbRating) {
        imdbRating = tmdbRating;
      }
    }

    try {
      const created = await prisma.movie.create({
        data: {
          imdbId,
          tmdbId,
          traktSlug,
          title: movie.title,
          year,
          posterUrl,
          overview,
          runtime,
          releaseDate,
          voteAverage: tmdbMovie?.vote_average ?? null,
          voteCount: tmdbMovie?.vote_count ?? null,
          popularity: tmdbMovie?.popularity ?? null,
          era,
          imdbRating,
          rottenTomatoesAudience,
        },
        select: { id: true },
      });
      if (imdbId) await backfillMLDataForMovie(created.id, imdbId);
      added++;
    } catch {
      // Skip if insert fails (e.g., duplicate)
      skipped++;
    }
  }

  console.log(`[Pool Expansion] Complete: ${added} added, ${skipped} skipped`);

  return {
    added,
    skipped,
    source: "trakt",
  };
}

/**
 * Trigger pool expansion for a user if needed (non-blocking)
 * Call this from the discover API to ensure users don't run out of movies
 */
export async function maybeExpandPoolForUser(userId: string): Promise<void> {
  const shouldExpand = await shouldExpandPool(userId);

  if (shouldExpand) {
    // Update cooldown immediately to prevent concurrent expansions
    expansionCooldowns.set(userId, Date.now());

    // Run expansion in background (don't await)
    expandMoviePool().catch((error) => {
      console.error("[Pool Expansion] Error during expansion:", error);
    });
  }
}

/**
 * Get expansion status for a user
 */
export async function getExpansionStatus(userId: string): Promise<{
  unratedCount: number;
  threshold: number;
  needsExpansion: boolean;
  onCooldown: boolean;
}> {
  const unratedCount = await getUnratedMovieCount(userId);
  const lastExpansion = expansionCooldowns.get(userId);
  const onCooldown = lastExpansion ? Date.now() - lastExpansion < EXPANSION_COOLDOWN_MS : false;

  return {
    unratedCount,
    threshold: EXPANSION_THRESHOLD,
    needsExpansion: unratedCount < EXPANSION_THRESHOLD,
    onCooldown,
  };
}




