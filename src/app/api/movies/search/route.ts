import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { searchOMDB, getOMDBMovie } from "@/lib/api/omdb";
import { searchTraktMovies } from "@/lib/api/trakt";
import { prisma } from "@/lib/prisma";
import {
  extractMovieMetadataFromRelations,
  splitCsvNames,
  syncMovieMetadataFromOMDB,
} from "@/lib/movie-metadata";

interface SearchMovieCandidate {
  imdbId: string;
  tmdbId?: string | null;
  traktSlug?: string | null;
  title: string;
  year: number | null;
  posterUrl: string | null;
  overview: string | null;
  runtime: number | null;
  directors: string[];
  actors: string[];
  studios: string[];
  details: Awaited<ReturnType<typeof getOMDBMovie>> | null;
}

function parseOptionalInt(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/\d+/);
  if (!match) return null;
  const parsed = Number.parseInt(match[0], 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function mergeUnique(values: string[], extras: string[], limit: number): string[] {
  return Array.from(new Set([...values, ...extras])).slice(0, limit);
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const query = req.nextUrl.searchParams.get("q");
  if (!query) {
    return NextResponse.json({ error: "Query required" }, { status: 400 });
  }

  const [omdbResults, traktResults] = await Promise.all([
    searchOMDB(query),
    searchTraktMovies(query),
  ]);

  // Merge and deduplicate by IMDB ID
  const seen = new Set<string>();
  const movies: SearchMovieCandidate[] = [];

  for (const r of omdbResults) {
    if (seen.has(r.imdbID)) continue;
    seen.add(r.imdbID);

    // Get full details
    const details = await getOMDBMovie(r.imdbID);
    movies.push({
      imdbId: r.imdbID,
      title: r.Title,
      year: parseOptionalInt(r.Year),
      posterUrl: r.Poster !== "N/A" ? r.Poster : null,
      overview: details?.Plot || null,
      runtime: parseOptionalInt(details?.Runtime),
      directors: splitCsvNames(details?.Director, 2),
      actors: splitCsvNames(details?.Actors, 3),
      studios: splitCsvNames(details?.Production, 2),
      details,
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
      year: r.movie.year ?? null,
      posterUrl: null,
      overview: null,
      runtime: null,
      directors: [],
      actors: [],
      studios: [],
      details: null,
    });
  }

  // Upsert movies into our database and return persisted IDs for rating flows
  const persistedMovies = [];
  for (const movie of movies) {
    const persisted = await prisma.movie.upsert({
      where: { imdbId: movie.imdbId },
      create: {
        imdbId: movie.imdbId,
        tmdbId: movie.tmdbId ?? null,
        traktSlug: movie.traktSlug ?? null,
        title: movie.title,
        year: movie.year,
        posterUrl: movie.posterUrl || null,
        overview: movie.overview,
        runtime: movie.runtime,
      },
      update: {
        title: movie.title,
        ...(movie.tmdbId !== undefined && { tmdbId: movie.tmdbId }),
        ...(movie.traktSlug !== undefined && { traktSlug: movie.traktSlug }),
        ...(movie.year !== null && { year: movie.year }),
        ...(movie.posterUrl !== null && { posterUrl: movie.posterUrl }),
        ...(movie.overview !== null && { overview: movie.overview }),
        ...(movie.runtime !== null && { runtime: movie.runtime }),
      },
      include: {
        cast: {
          include: { person: { select: { name: true } } },
          orderBy: { castOrder: "asc" },
          take: 3,
        },
        crew: {
          where: { job: "Director" },
          include: { person: { select: { name: true } } },
          take: 3,
        },
        studios: {
          include: { studio: { select: { name: true } } },
          take: 2,
        },
      },
    });

    const relationMetadata = extractMovieMetadataFromRelations(persisted);
    let metadata = relationMetadata;
    metadata = {
      actors: mergeUnique(metadata.actors, movie.actors, 3),
      directors: mergeUnique(metadata.directors, movie.directors, 2),
      studios: mergeUnique(metadata.studios, movie.studios, 2),
      genres: metadata.genres,
    };
    const shouldSyncMetadata =
      movie.details &&
      (relationMetadata.actors.length === 0 ||
        relationMetadata.directors.length === 0 ||
        relationMetadata.studios.length === 0);
    if (shouldSyncMetadata && movie.details) {
      const synced = await syncMovieMetadataFromOMDB(persisted.id, movie.details);
      metadata = {
        actors: mergeUnique(metadata.actors, synced.actors, 3),
        directors: mergeUnique(metadata.directors, synced.directors, 2),
        studios: mergeUnique(metadata.studios, synced.studios, 2),
        genres: mergeUnique(metadata.genres, synced.genres, 4),
      };
    }

    persistedMovies.push({
      id: persisted.id,
      imdbId: persisted.imdbId,
      title: persisted.title,
      year: persisted.year,
      posterUrl: persisted.posterUrl,
      overview: persisted.overview,
      era: persisted.era,
      directors: metadata.directors,
      actors: metadata.actors,
      studios: metadata.studios,
    });
  }

  return NextResponse.json(persistedMovies.slice(0, 20));
}
