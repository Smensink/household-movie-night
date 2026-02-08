import { prisma } from "./prisma";
import { getTrendingMovies, getPopularMovies, getAnticipatedMovies } from "./api/trakt";
import { getOMDBMovie, getHighResPosterUrl, extractRatingsFromOMDB } from "./api/omdb";
import { getTMDBMovieByImdbId, extractTMDBRating } from "./api/tmdb";

const EXPANSION_THRESHOLD = 50; // Trigger expansion when user has fewer than this many unrated movies
const EXPANSION_BATCH_SIZE = 30; // How many movies to add per expansion
const EXPANSION_COOLDOWN_MS = 5 * 60_000; // Only expand every 5 minutes per user

// Track last expansion time per user
const expansionCooldowns = new Map<string, number>();

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

  // Get movies from multiple sources
  const [trending, popular, anticipated] = await Promise.all([
    getTrendingMovies(EXPANSION_BATCH_SIZE),
    getPopularMovies(EXPANSION_BATCH_SIZE),
    getAnticipatedMovies(EXPANSION_BATCH_SIZE),
  ]);

  const allMovies = [
    ...trending.map((t) => t.movie),
    ...popular,
    ...anticipated.map((a) => a.movie),
  ];

  // Dedupe by IMDB ID
  const seenImdbIds = new Set<string>();
  const uniqueMovies: typeof allMovies = [];
  for (const movie of allMovies) {
    const imdbId = movie.ids?.imdb;
    if (!imdbId || seenImdbIds.has(imdbId)) continue;
    seenImdbIds.add(imdbId);
    uniqueMovies.push(movie);
  }

  let added = 0;
  let skipped = 0;

  for (const movie of uniqueMovies.slice(0, EXPANSION_BATCH_SIZE)) {
    const imdbId = movie.ids?.imdb;
    if (!imdbId) {
      skipped++;
      continue;
    }

    // Check if already exists
    const existing = await prisma.movie.findFirst({
      where: {
        OR: [
          { imdbId },
          { tmdbId: movie.ids?.tmdb?.toString() },
        ],
      },
      select: { id: true },
    });

    if (existing) {
      skipped++;
      continue;
    }

    // Fetch OMDB details for metadata
    const details = await getOMDBMovie(imdbId);
    if (!details) {
      skipped++;
      continue;
    }

    const year = movie.year || parseOptionalInt(details.Year) || null;
    const runtime = parseOptionalInt(details.Runtime) || null;
    const era = getEra(year);
    const posterUrl = getHighResPosterUrl(details.Poster);

    // Get ratings with fallback sources
    let imdbRating: number | null = null;
    let rottenTomatoesAudience: number | null = null;

    const omdbRatings = extractRatingsFromOMDB(details);
    imdbRating = omdbRatings.imdbRating;
    rottenTomatoesAudience = omdbRatings.rottenTomatoesAudience;

    // Fallback to TMDB for rating if needed
    if (!imdbRating) {
      const tmdbMovie = await getTMDBMovieByImdbId(imdbId);
      const tmdbRating = extractTMDBRating(tmdbMovie);
      if (tmdbRating) {
        imdbRating = tmdbRating;
      }
    }

    try {
      await prisma.movie.create({
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
      });
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
