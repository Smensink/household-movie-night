const OMDB_BASE = "https://www.omdbapi.com";

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
  imdbRating?: string;
  Rated?: string;
}

export async function searchOMDB(query: string): Promise<OMDBMovie[]> {
  const apiKey = process.env.OMDB_API_KEY;
  if (!apiKey) return [];

  const res = await fetch(
    `${OMDB_BASE}/?apikey=${apiKey}&s=${encodeURIComponent(query)}&type=movie`
  );
  const data = await res.json();
  return data.Search || [];
}

export async function getOMDBMovie(imdbId: string): Promise<OMDBMovie | null> {
  const apiKey = process.env.OMDB_API_KEY;
  if (!apiKey) return null;

  const res = await fetch(`${OMDB_BASE}/?apikey=${apiKey}&i=${imdbId}&plot=full`);
  const data = await res.json();
  if (data.Response === "False") return null;
  return data;
}
