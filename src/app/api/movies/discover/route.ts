import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getTrendingMovies, getPopularMovies } from "@/lib/api/trakt";
import { getOMDBMovie } from "@/lib/api/omdb";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Get user's existing ratings to know what to exclude
  const existingRatings = await prisma.movieRating.findMany({
    where: { userId: session.user.id },
    select: { movie: { select: { imdbId: true } } },
  });
  const ratedImdbIds = new Set(
    existingRatings.map((r) => r.movie.imdbId).filter(Boolean)
  );

  // Fetch from Trakt
  const [trending, popular] = await Promise.all([
    getTrendingMovies(20),
    getPopularMovies(20),
  ]);

  const movies = [];
  const seen = new Set<string>();

  // Combine and process
  const allTraktMovies = [
    ...trending.map((t) => ({ ...t.movie, source: "trending" })),
    ...popular.map((p) => ({ ...p, source: "popular" })),
  ];

  for (const m of allTraktMovies) {
    const imdbId = m.ids?.imdb;
    if (!imdbId || seen.has(imdbId) || ratedImdbIds.has(imdbId)) continue;
    seen.add(imdbId);

    // Get OMDB details for poster
    const details = await getOMDBMovie(imdbId);

    const year = m.year || (details?.Year ? parseInt(details.Year) : null);
    const era = getEra(year);

    const movie = await prisma.movie.upsert({
      where: { imdbId },
      create: {
        imdbId,
        tmdbId: m.ids?.tmdb?.toString() || null,
        traktSlug: m.ids?.slug || null,
        title: m.title,
        year,
        posterUrl: details?.Poster !== "N/A" ? details?.Poster || null : null,
        overview: details?.Plot || null,
        runtime: details?.Runtime ? parseInt(details.Runtime) : null,
        era,
      },
      update: {
        posterUrl: details?.Poster !== "N/A" ? details?.Poster || null : undefined,
        era: era || undefined,
      },
    });

    movies.push({
      id: movie.id,
      imdbId,
      title: m.title,
      year,
      posterUrl: movie.posterUrl,
      overview: movie.overview,
      era,
      source: (m as Record<string, unknown>).source,
    });

    if (movies.length >= 15) break;
  }

  return NextResponse.json(movies);
}

function getEra(year: number | null): string | null {
  if (!year) return null;
  const currentYear = new Date().getFullYear();
  if (year >= currentYear - 1) return "new_release";
  if (year >= 2000) return "modern_classic";
  return "classic";
}
