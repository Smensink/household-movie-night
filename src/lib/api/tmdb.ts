import { prisma } from "../prisma";

const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";
const API_KEY_TTL_MS = 60_000;
const MOVIE_CACHE_TTL_MS = 6 * 60 * 60_000;
const PERSON_CACHE_TTL_MS = 6 * 60 * 60_000;
const MAX_CACHE_SIZE = 500;

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

export interface TMDBMovie {
  id: number;
  imdb_id?: string;
  title: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  runtime?: number;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  genres?: { id: number; name: string }[];
  production_companies?: { id: number; name: string; logo_path?: string }[];
  credits?: {
    cast?: { id: number; name: string; character?: string; profile_path?: string | null; order: number }[];
    crew?: { id: number; name: string; job: string; profile_path?: string | null }[];
  };
}

export interface TMDBPerson {
  id: number;
  name: string;
  profile_path?: string | null;
  biography?: string;
  birthday?: string;
  known_for_department?: string;
  movie_credits?: {
    cast?: { id: number; title: string; character?: string; poster_path?: string | null; release_date?: string; vote_average?: number }[];
    crew?: { id: number; title: string; job: string; poster_path?: string | null; release_date?: string }[];
  };
}

export interface TMDBSearchResult {
  id: number;
  name?: string;
  title?: string;
  profile_path?: string | null;
  poster_path?: string | null;
  known_for_department?: string;
  media_type?: string;
}

let tmdbApiKeyCache: CacheEntry<string | null> | null = null;
const tmdbMovieCache = new Map<string, CacheEntry<TMDBMovie | null>>();
const tmdbPersonCache = new Map<string, CacheEntry<TMDBPerson | null>>();

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const cached = cache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
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
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

async function getTMDBApiKey(): Promise<string | null> {
  if (tmdbApiKeyCache && tmdbApiKeyCache.expiresAt > Date.now()) {
    return tmdbApiKeyCache.value;
  }

  const config = await prisma.integrationConfig.findUnique({
    where: { service: "tmdb" },
    select: { enabled: true, apiKey: true },
  });

  if (config?.enabled && config.apiKey) {
    tmdbApiKeyCache = {
      value: config.apiKey,
      expiresAt: Date.now() + API_KEY_TTL_MS,
    };
    return config.apiKey;
  }

  const fallback = process.env.TMDB_API_KEY || null;
  tmdbApiKeyCache = {
    value: fallback,
    expiresAt: Date.now() + API_KEY_TTL_MS,
  };
  return fallback;
}

/**
 * Get full poster URL from TMDB path
 */
export function getTMDBPosterUrl(posterPath: string | null | undefined, size: "w342" | "w500" | "w780" | "original" = "w780"): string | null {
  if (!posterPath) return null;
  return `${TMDB_IMAGE_BASE}/${size}${posterPath}`;
}

/**
 * Get profile image URL from TMDB path
 */
export function getTMDBProfileUrl(profilePath: string | null | undefined, size: "w185" | "w342" | "h632" | "original" = "h632"): string | null {
  if (!profilePath) return null;
  return `${TMDB_IMAGE_BASE}/${size}${profilePath}`;
}

/**
 * Fetch movie details from TMDB by IMDB ID
 */
export async function getTMDBMovieByImdbId(imdbId: string): Promise<TMDBMovie | null> {
  const cacheKey = `imdb:${imdbId}`;
  const cached = getCached(tmdbMovieCache, cacheKey);
  if (cached !== undefined) return cached;

  const apiKey = await getTMDBApiKey();
  if (!apiKey) return null;

  try {
    // First find the TMDB ID from IMDB ID
    const findRes = await fetch(
      `${TMDB_BASE}/find/${imdbId}?api_key=${apiKey}&external_source=imdb_id`,
      { cache: "no-store" }
    );
    if (!findRes.ok) return null;

    const findData = await findRes.json();
    const movieResult = findData.movie_results?.[0];
    if (!movieResult?.id) {
      setCached(tmdbMovieCache, cacheKey, null, MOVIE_CACHE_TTL_MS);
      return null;
    }

    // Fetch full movie details with credits
    const detailsRes = await fetch(
      `${TMDB_BASE}/movie/${movieResult.id}?api_key=${apiKey}&append_to_response=credits`,
      { cache: "no-store" }
    );
    if (!detailsRes.ok) {
      setCached(tmdbMovieCache, cacheKey, null, MOVIE_CACHE_TTL_MS);
      return null;
    }

    const movie: TMDBMovie = await detailsRes.json();
    setCached(tmdbMovieCache, cacheKey, movie, MOVIE_CACHE_TTL_MS);
    return movie;
  } catch {
    return null;
  }
}

/**
 * Fetch movie details from TMDB by TMDB ID
 */
export async function getTMDBMovie(tmdbId: string | number): Promise<TMDBMovie | null> {
  const cacheKey = `tmdb:${tmdbId}`;
  const cached = getCached(tmdbMovieCache, cacheKey);
  if (cached !== undefined) return cached;

  const apiKey = await getTMDBApiKey();
  if (!apiKey) return null;

  try {
    const res = await fetch(
      `${TMDB_BASE}/movie/${tmdbId}?api_key=${apiKey}&append_to_response=credits`,
      { cache: "no-store" }
    );
    if (!res.ok) {
      setCached(tmdbMovieCache, cacheKey, null, MOVIE_CACHE_TTL_MS);
      return null;
    }

    const movie: TMDBMovie = await res.json();
    setCached(tmdbMovieCache, cacheKey, movie, MOVIE_CACHE_TTL_MS);
    return movie;
  } catch {
    return null;
  }
}

/**
 * Search for a person by name on TMDB
 */
export async function searchTMDBPerson(name: string): Promise<TMDBSearchResult | null> {
  const apiKey = await getTMDBApiKey();
  if (!apiKey) return null;

  try {
    const res = await fetch(
      `${TMDB_BASE}/search/person?api_key=${apiKey}&query=${encodeURIComponent(name)}`,
      { cache: "no-store" }
    );
    if (!res.ok) return null;

    const data = await res.json();
    return data.results?.[0] || null;
  } catch {
    return null;
  }
}

/**
 * Fetch person details from TMDB by ID
 */
export async function getTMDBPerson(tmdbId: number): Promise<TMDBPerson | null> {
  const cacheKey = `person:${tmdbId}`;
  const cached = getCached(tmdbPersonCache, cacheKey);
  if (cached !== undefined) return cached;

  const apiKey = await getTMDBApiKey();
  if (!apiKey) return null;

  try {
    const res = await fetch(
      `${TMDB_BASE}/person/${tmdbId}?api_key=${apiKey}&append_to_response=movie_credits`,
      { cache: "no-store" }
    );
    if (!res.ok) {
      setCached(tmdbPersonCache, cacheKey, null, PERSON_CACHE_TTL_MS);
      return null;
    }

    const person: TMDBPerson = await res.json();
    setCached(tmdbPersonCache, cacheKey, person, PERSON_CACHE_TTL_MS);
    return person;
  } catch {
    return null;
  }
}

/**
 * Get person details by name (searches first, then fetches full details)
 */
export async function getTMDBPersonByName(name: string): Promise<TMDBPerson | null> {
  const searchResult = await searchTMDBPerson(name);
  if (!searchResult?.id) return null;
  return getTMDBPerson(searchResult.id);
}

/**
 * Extract TMDB rating (vote_average is on 0-10 scale)
 * Returns null if no valid rating
 */
export function extractTMDBRating(movie: TMDBMovie | null): number | null {
  if (!movie?.vote_average) return null;
  // TMDB uses 0-10 scale, same as IMDB
  const rating = movie.vote_average;
  if (rating <= 0 || rating > 10) return null;
  return Math.round(rating * 10) / 10; // Round to 1 decimal
}

/**
 * Search for a movie by title on TMDB
 */
export async function searchTMDBMovie(title: string, year?: number | null): Promise<TMDBMovie | null> {
  const apiKey = await getTMDBApiKey();
  if (!apiKey) return null;

  try {
    let url = `${TMDB_BASE}/search/movie?api_key=${apiKey}&query=${encodeURIComponent(title)}`;
    if (year) {
      url += `&year=${year}`;
    }

    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;

    const data = await res.json();
    const result = data.results?.[0];
    if (!result) return null;

    // Return a basic TMDBMovie object
    return {
      id: result.id,
      title: result.title,
      overview: result.overview,
      poster_path: result.poster_path,
      backdrop_path: result.backdrop_path,
      release_date: result.release_date,
      vote_average: result.vote_average,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch and persist a poster for a movie that's missing one
 * Returns the updated poster URL or null if not found
 */
export async function fetchAndPersistMoviePoster(
  movieId: string,
  imdbId: string | null | undefined,
  title: string,
  year: number | null | undefined
): Promise<string | null> {
  // Try TMDB by IMDB ID first
  if (imdbId) {
    const tmdbMovie = await getTMDBMovieByImdbId(imdbId);
    if (tmdbMovie?.poster_path) {
      const posterUrl = getTMDBPosterUrl(tmdbMovie.poster_path, "w780");
      if (posterUrl) {
        await prisma.movie.update({
          where: { id: movieId },
          data: { posterUrl },
        });
        return posterUrl;
      }
    }
  }

  // Fallback: search TMDB by title and year
  const searchResult = await searchTMDBMovie(title, year);
  if (searchResult?.poster_path) {
    const posterUrl = getTMDBPosterUrl(searchResult.poster_path, "w780");
    if (posterUrl) {
      await prisma.movie.update({
        where: { id: movieId },
        data: { posterUrl },
      });
      return posterUrl;
    }
  }

  return null;
}

export interface TMDBCompany {
  id: number;
  name: string;
  logo_path?: string | null;
}

export interface TMDBDiscoverMovie {
  id: number;
  title: string;
  overview?: string;
  poster_path?: string | null;
  release_date?: string;
  vote_average?: number;
  popularity?: number;
}

/**
 * Search for a company/studio by name on TMDB
 */
export async function searchTMDBCompany(name: string): Promise<TMDBCompany | null> {
  const apiKey = await getTMDBApiKey();
  if (!apiKey) return null;

  try {
    const res = await fetch(
      `${TMDB_BASE}/search/company?api_key=${apiKey}&query=${encodeURIComponent(name)}`,
      { cache: "no-store" }
    );
    if (!res.ok) return null;

    const data = await res.json();
    return data.results?.[0] || null;
  } catch {
    return null;
  }
}

/**
 * Get popular movies from a company/studio by TMDB company ID
 */
export async function getTMDBCompanyMovies(
  companyId: number,
  limit = 10
): Promise<TMDBDiscoverMovie[]> {
  const apiKey = await getTMDBApiKey();
  if (!apiKey) return [];

  try {
    const res = await fetch(
      `${TMDB_BASE}/discover/movie?api_key=${apiKey}&with_companies=${companyId}&sort_by=popularity.desc&page=1`,
      { cache: "no-store" }
    );
    if (!res.ok) return [];

    const data = await res.json();
    const results: TMDBDiscoverMovie[] = data.results || [];
    return results.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Get full movie details by TMDB ID (includes IMDB ID needed for our DB)
 */
export async function getTMDBMovieDetails(tmdbId: number): Promise<TMDBMovie | null> {
  return getTMDBMovie(tmdbId);
}
