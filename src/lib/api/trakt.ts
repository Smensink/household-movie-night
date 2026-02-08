import { prisma } from "../prisma";
const TRAKT_BASE = "https://api.trakt.tv";
const API_KEY_TTL_MS = 60_000;
const TRENDING_CACHE_TTL_MS = 15 * 60_000;
const POPULAR_CACHE_TTL_MS = 15 * 60_000;
const BOX_OFFICE_CACHE_TTL_MS = 10 * 60_000;
const SEARCH_CACHE_TTL_MS = 10 * 60_000;
const ANTICIPATED_CACHE_TTL_MS = 30 * 60_000;
const MAX_CACHE_SIZE = 300;

interface TraktMovie {
  title: string;
  year: number;
  ids: {
    trakt: number;
    slug: string;
    imdb: string;
    tmdb: number;
  };
}

interface TraktTrendingItem {
  watchers: number;
  movie: TraktMovie;
}

type TraktPopularItem = TraktMovie;

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

let traktApiKeyCache: CacheEntry<string | null> | null = null;
const trendingCache = new Map<string, CacheEntry<TraktTrendingItem[]>>();
const popularCache = new Map<string, CacheEntry<TraktPopularItem[]>>();
const boxOfficeCache = new Map<string, CacheEntry<{ revenue: number; movie: TraktMovie }[]>>();
const traktSearchCache = new Map<string, CacheEntry<{ movie: TraktMovie }[]>>();
const anticipatedCache = new Map<string, CacheEntry<{ list_count: number; movie: TraktMovie }[]>>();

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

async function getTraktApiKey(): Promise<string | null> {
  if (traktApiKeyCache && traktApiKeyCache.expiresAt > Date.now()) {
    return traktApiKeyCache.value;
  }

  const config = await prisma.integrationConfig.findUnique({
    where: { service: "trakt" },
    select: { enabled: true, apiKey: true },
  });

  if (config?.enabled && config.apiKey) {
    traktApiKeyCache = {
      value: config.apiKey,
      expiresAt: Date.now() + API_KEY_TTL_MS,
    };
    return config.apiKey;
  }

  const fallback = process.env.TRAKT_CLIENT_ID || null;
  traktApiKeyCache = {
    value: fallback,
    expiresAt: Date.now() + API_KEY_TTL_MS,
  };
  return fallback;
}

function getHeaders(apiKey: string) {
  return {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": apiKey,
  };
}

export async function getTrendingMovies(
  limit = 20
): Promise<TraktTrendingItem[]> {
  const cacheKey = String(limit);
  const cached = getCached(trendingCache, cacheKey);
  if (cached) return cached;

  const apiKey = await getTraktApiKey();
  if (!apiKey) return [];
  const res = await fetch(
    `${TRAKT_BASE}/movies/trending?limit=${limit}`,
    { headers: getHeaders(apiKey), cache: "no-store" }
  );
  if (!res.ok) return [];
  const data = await res.json().catch(() => []);
  const movies: TraktTrendingItem[] = Array.isArray(data) ? data : [];
  setCached(trendingCache, cacheKey, movies, TRENDING_CACHE_TTL_MS);
  return movies;
}

export async function getPopularMovies(limit = 20): Promise<TraktPopularItem[]> {
  const cacheKey = String(limit);
  const cached = getCached(popularCache, cacheKey);
  if (cached) return cached;

  const apiKey = await getTraktApiKey();
  if (!apiKey) return [];
  const res = await fetch(
    `${TRAKT_BASE}/movies/popular?limit=${limit}`,
    { headers: getHeaders(apiKey), cache: "no-store" }
  );
  if (!res.ok) return [];
  const data = await res.json().catch(() => []);
  const movies: TraktPopularItem[] = Array.isArray(data) ? data : [];
  setCached(popularCache, cacheKey, movies, POPULAR_CACHE_TTL_MS);
  return movies;
}

export async function getBoxOfficeMovies(): Promise<
  { revenue: number; movie: TraktMovie }[]
> {
  const cacheKey = "boxoffice";
  const cached = getCached(boxOfficeCache, cacheKey);
  if (cached) return cached;

  const apiKey = await getTraktApiKey();
  if (!apiKey) return [];
  const res = await fetch(`${TRAKT_BASE}/movies/boxoffice`, {
    headers: getHeaders(apiKey),
    cache: "no-store",
  });
  if (!res.ok) return [];
  const data = await res.json().catch(() => []);
  const movies: { revenue: number; movie: TraktMovie }[] = Array.isArray(data)
    ? data
    : [];
  setCached(boxOfficeCache, cacheKey, movies, BOX_OFFICE_CACHE_TTL_MS);
  return movies;
}

export async function searchTraktMovies(
  query: string
): Promise<{ movie: TraktMovie }[]> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];

  const cached = getCached(traktSearchCache, normalizedQuery);
  if (cached) return cached;

  const apiKey = await getTraktApiKey();
  if (!apiKey) return [];
  const res = await fetch(
    `${TRAKT_BASE}/search/movie?query=${encodeURIComponent(query)}`,
    { headers: getHeaders(apiKey), cache: "no-store" }
  );
  if (!res.ok) return [];
  const data = await res.json().catch(() => []);
  const movies: { movie: TraktMovie }[] = Array.isArray(data) ? data : [];
  setCached(traktSearchCache, normalizedQuery, movies, SEARCH_CACHE_TTL_MS);
  return movies;
}

export async function getAnticipatedMovies(
  limit = 20,
  page = 1
): Promise<{ list_count: number; movie: TraktMovie }[]> {
  const normalizedPage = Math.max(1, page);
  const cacheKey = `${limit}:${normalizedPage}`;
  const cached = getCached(anticipatedCache, cacheKey);
  if (cached) return cached;

  const apiKey = await getTraktApiKey();
  if (!apiKey) return [];

  const res = await fetch(
    `${TRAKT_BASE}/movies/anticipated?limit=${limit}&page=${normalizedPage}`,
    { headers: getHeaders(apiKey), cache: "no-store" }
  );
  if (!res.ok) return [];

  const data = await res.json().catch(() => []);
  const movies: { list_count: number; movie: TraktMovie }[] = Array.isArray(data) ? data : [];
  setCached(anticipatedCache, cacheKey, movies, ANTICIPATED_CACHE_TTL_MS);
  return movies;
}

export interface TraktRatings {
  rating: number; // 0-10 scale
  votes: number;
  distribution: Record<string, number>;
}

const ratingsCache = new Map<string, CacheEntry<TraktRatings | null>>();
const RATINGS_CACHE_TTL_MS = 60 * 60_000; // 1 hour

/**
 * Get Trakt ratings for a movie by IMDB ID or Trakt slug
 */
export async function getTraktMovieRatings(
  idOrSlug: string
): Promise<TraktRatings | null> {
  const cacheKey = `ratings:${idOrSlug}`;
  const cached = getCached(ratingsCache, cacheKey);
  if (cached !== null) return cached;

  const apiKey = await getTraktApiKey();
  if (!apiKey) return null;

  try {
    const res = await fetch(
      `${TRAKT_BASE}/movies/${idOrSlug}/ratings`,
      { headers: getHeaders(apiKey), cache: "no-store" }
    );
    if (!res.ok) {
      setCached(ratingsCache, cacheKey, null, RATINGS_CACHE_TTL_MS);
      return null;
    }

    const data: TraktRatings = await res.json();
    setCached(ratingsCache, cacheKey, data, RATINGS_CACHE_TTL_MS);
    return data;
  } catch {
    return null;
  }
}

