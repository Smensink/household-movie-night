import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { searchOMDB, getOMDBMovie } from "@/lib/api/omdb";
import { searchTraktMovies } from "@/lib/api/trakt";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const query = req.nextUrl.searchParams.get("q");
  if (!query) {
    return NextResponse.json({ error: "Query required" }, { status: 400 });
  }

  // Search OMDB
  const omdbResults = await searchOMDB(query);

  // Search Trakt
  const traktResults = await searchTraktMovies(query);

  // Merge and deduplicate by IMDB ID
  const seen = new Set<string>();
  const movies = [];

  for (const r of omdbResults) {
    if (seen.has(r.imdbID)) continue;
    seen.add(r.imdbID);

    // Get full details
    const details = await getOMDBMovie(r.imdbID);
    movies.push({
      imdbId: r.imdbID,
      title: r.Title,
      year: parseInt(r.Year) || null,
      posterUrl: r.Poster !== "N/A" ? r.Poster : null,
      overview: details?.Plot || null,
      runtime: details?.Runtime ? parseInt(details.Runtime) : null,
    });
  }

  for (const r of traktResults) {
    if (!r.movie?.ids?.imdb || seen.has(r.movie.ids.imdb)) continue;
    seen.add(r.movie.ids.imdb);
    movies.push({
      imdbId: r.movie.ids.imdb,
      tmdbId: r.movie.ids.tmdb?.toString() || null,
      traktSlug: r.movie.ids.slug,
      title: r.movie.title,
      year: r.movie.year,
      posterUrl: null,
    });
  }

  // Upsert movies into our database
  for (const movie of movies) {
    await prisma.movie.upsert({
      where: { imdbId: movie.imdbId },
      create: {
        imdbId: movie.imdbId,
        tmdbId: "tmdbId" in movie ? (movie.tmdbId as string) : null,
        traktSlug: "traktSlug" in movie ? (movie.traktSlug as string) : null,
        title: movie.title,
        year: movie.year,
        posterUrl: movie.posterUrl || null,
        overview: "overview" in movie ? (movie.overview as string) : null,
        runtime: "runtime" in movie ? (movie.runtime as number) : null,
      },
      update: {},
    });
  }

  return NextResponse.json(movies.slice(0, 20));
}
