const TRAKT_BASE = "https://api.trakt.tv";

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

function getHeaders() {
  return {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": process.env.TRAKT_CLIENT_ID || "",
  };
}

export async function getTrendingMovies(
  limit = 20
): Promise<TraktTrendingItem[]> {
  if (!process.env.TRAKT_CLIENT_ID) return [];
  const res = await fetch(
    `${TRAKT_BASE}/movies/trending?limit=${limit}`,
    { headers: getHeaders() }
  );
  if (!res.ok) return [];
  return res.json();
}

export async function getPopularMovies(limit = 20): Promise<TraktPopularItem[]> {
  if (!process.env.TRAKT_CLIENT_ID) return [];
  const res = await fetch(
    `${TRAKT_BASE}/movies/popular?limit=${limit}`,
    { headers: getHeaders() }
  );
  if (!res.ok) return [];
  return res.json();
}

export async function getBoxOfficeMovies(): Promise<
  { revenue: number; movie: TraktMovie }[]
> {
  if (!process.env.TRAKT_CLIENT_ID) return [];
  const res = await fetch(`${TRAKT_BASE}/movies/boxoffice`, {
    headers: getHeaders(),
  });
  if (!res.ok) return [];
  return res.json();
}

export async function searchTraktMovies(
  query: string
): Promise<{ movie: TraktMovie }[]> {
  if (!process.env.TRAKT_CLIENT_ID) return [];
  const res = await fetch(
    `${TRAKT_BASE}/search/movie?query=${encodeURIComponent(query)}`,
    { headers: getHeaders() }
  );
  if (!res.ok) return [];
  return res.json();
}
