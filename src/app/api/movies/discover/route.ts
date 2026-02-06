import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getTrendingMovies, getPopularMovies } from "@/lib/api/trakt";
import { getOMDBMovie } from "@/lib/api/omdb";
import { prisma } from "@/lib/prisma";

type DiscoverSource = "trending" | "popular";

function parseOptionalInt(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/\d+/);
  if (!match) return null;
  const parsed = Number.parseInt(match[0], 10);
  return Number.isNaN(parsed) ? null : parsed;
}

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
  const allTraktMovies: Array<
    (typeof trending)[number]["movie"] & { source: DiscoverSource }
  > = [
    ...trending.map((t) => ({ ...t.movie, source: "trending" as const })),
    ...popular.map((p) => ({ ...p, source: "popular" as const })),
  ];

  for (const m of allTraktMovies) {
    const imdbId = m.ids?.imdb;
    if (!imdbId || seen.has(imdbId) || ratedImdbIds.has(imdbId)) continue;
    seen.add(imdbId);

    // Get OMDB details for poster
    const details = await getOMDBMovie(imdbId);

    const year = m.year || parseOptionalInt(details?.Year);
    const era = getEra(year);
    const runtime = parseOptionalInt(details?.Runtime);

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
        runtime,
        era,
      },
      update: {
        title: m.title,
        ...(year !== null && { year }),
        posterUrl: details?.Poster !== "N/A" ? details?.Poster || null : undefined,
        ...(details?.Plot && { overview: details.Plot }),
        ...(runtime !== null && { runtime }),
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
      source: m.source,
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
