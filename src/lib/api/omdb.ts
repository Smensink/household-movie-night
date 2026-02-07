import { prisma } from "../prisma";

const OMDB_BASE = "https://www.omdbapi.com";
const API_KEY_TTL_MS = 60_000;
const SEARCH_CACHE_TTL_MS = 30 * 60_000;
const MOVIE_CACHE_TTL_MS = 6 * 60 * 60_000;
const MAX_CACHE_SIZE = 500;

export interface OMDBRating {
  Source: string;
  Value: string;
}

export interface OMDBMovie {
  Title: string;
  Year: string;
  imdbID: string;
  Type: string;
  Poster: string;
  Plot?: string;
  Runtime?: string;
  Genre?: string;
  Director?: string;
  Actors?: string;
  Production?: string;
  imdbRating?: string;
  Rated?: string;
  Ratings?: OMDBRating[];
}

export interface ExtractedRatings {
  imdbRating: number | null;
  rottenTomatoesAudience: number | null;
}

/**
 * Extract IMDB rating and Rotten Tomatoes audience score from OMDB data
 */
export function extractRatingsFromOMDB(movie: OMDBMovie): ExtractedRatings {
  let imdbRating: number | null = null;
  let rottenTomatoesAudience: number | null = null;

  // Extract IMDB rating
  if (movie.imdbRating && movie.imdbRating !== "N/A") {
    const parsed = parseFloat(movie.imdbRating);
    if (!isNaN(parsed)) {
      imdbRating = parsed;
    }
  }

  // Extract Rotten Tomatoes from Ratings array
  if (movie.Ratings && Array.isArray(movie.Ratings)) {
    const rtRating = movie.Ratings.find(r => r.Source === "Rotten Tomatoes");
    if (rtRating?.Value) {
      const match = rtRating.Value.match(/(\d+)%/);
      if (match) {
        rottenTomatoesAudience = parseInt(match[1], 10);
      }
    }
  }

  return { imdbRating, rottenTomatoesAudience };
}

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

let omdbApiKeyCache: CacheEntry<string | null> | null = null;
const omdbSearchCache = new Map<string, CacheEntry<OMDBMovie[]>>();
const omdbMovieCache = new Map<string, CacheEntry<OMDBMovie | null>>();

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const cached = cache.get(key);
  if (!cached) return null;
  if (cached.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return cached.value;
}

function setCached<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number
) {
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) {
      cache.delete(oldestKey);
    }
  }

  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

async function getOMDBApiKey(): Promise<string | null> {
  if (omdbApiKeyCache && omdbApiKeyCache.expiresAt > Date.now()) {
    return omdbApiKeyCache.value;
  }

  const config = await prisma.integrationConfig.findUnique({
    where: { service: "omdb" },
    select: { enabled: true, apiKey: true },
  });

  if (config?.enabled && config.apiKey) {
    omdbApiKeyCache = {
      value: config.apiKey,
      expiresAt: Date.now() + API_KEY_TTL_MS,
    };
    return config.apiKey;
  }

  const fallback = process.env.OMDB_API_KEY || null;
  omdbApiKeyCache = {
    value: fallback,
    expiresAt: Date.now() + API_KEY_TTL_MS,
  };
  return fallback;
}

export async function searchOMDB(query: string): Promise<OMDBMovie[]> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];

  const cached = getCached(omdbSearchCache, normalizedQuery);
  if (cached) {
    return cached;
  }

  const apiKey = await getOMDBApiKey();
  if (!apiKey) return [];

  const res = await fetch(`${OMDB_BASE}/?apikey=${apiKey}&s=${encodeURIComponent(query)}&type=movie`, {
    cache: "no-store",
  });
  if (!res.ok) return [];

  const data = await res.json().catch(() => null);
  const results: OMDBMovie[] = Array.isArray(data?.Search) ? data.Search : [];
  setCached(omdbSearchCache, normalizedQuery, results, SEARCH_CACHE_TTL_MS);
  return results;
}

/**
 * Upgrades OMDB poster URL to higher resolution.
 * OMDB returns URLs like: https://m.media-amazon.com/images/M/...@._V1_SX300.jpg
 * We replace SX300 with SX1000 for better quality.
 */
export function getHighResPosterUrl(posterUrl: string | null | undefined): string | null {
  if (!posterUrl || posterUrl === "N/A") return null;
  // Replace common low-res suffixes with high-res versions
  return posterUrl
    .replace(/_SX\d+\./, "_SX1000.")
    .replace(/_SY\d+\./, "_SY1500.")
    .replace(/@\._V1_SX\d+/, "@._V1_SX1000")
    .replace(/@\._V1_SY\d+/, "@._V1_SY1500");
}

export async function getOMDBMovie(imdbId: string): Promise<OMDBMovie | null> {
  const normalizedImdbId = imdbId.trim().toLowerCase();
  if (!normalizedImdbId) return null;

  const cachedEntry = omdbMovieCache.get(normalizedImdbId);
  if (cachedEntry) {
    if (cachedEntry.expiresAt >= Date.now()) {
      return cachedEntry.value;
    }
    omdbMovieCache.delete(normalizedImdbId);
  }

  const apiKey = await getOMDBApiKey();
  if (!apiKey) return null;

  const res = await fetch(`${OMDB_BASE}/?apikey=${apiKey}&i=${imdbId}&plot=full`, {
    cache: "no-store",
  });
  if (!res.ok) return null;

  const data = await res.json().catch(() => null);
  if (!data || data.Response === "False") {
    setCached(omdbMovieCache, normalizedImdbId, null, MOVIE_CACHE_TTL_MS);
    return null;
  }

  // Upgrade poster to high resolution
  if (data.Poster) {
    data.Poster = getHighResPosterUrl(data.Poster) || data.Poster;
  }

  setCached(omdbMovieCache, normalizedImdbId, data as OMDBMovie, MOVIE_CACHE_TTL_MS);
  return data as OMDBMovie;
}
