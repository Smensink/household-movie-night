import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAnticipatedMovies } from "@/lib/api/trakt";
import { getOMDBMovie } from "@/lib/api/omdb";
import { prisma } from "@/lib/prisma";
import { syncMovieMetadataFromOMDB } from "@/lib/movie-metadata";
import { syncMoviesToRadarr } from "@/lib/api/radarr";
import { isUserHouseholdAdmin } from "@/lib/household-admin";

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 30;

interface UpcomingMovieResponse {
  id: string;
  imdbId: string | null;
  tmdbId: string | null;
  title: string;
  year: number | null;
  posterUrl: string | null;
  overview: string | null;
  releaseDate: string | null;
  listCount: number;
  actors: string[];
  directors: string[];
  studios: string[];
  consensus: {
    ratingCount: number;
    averageRating: number | null;
    userRating: number | null;
  };
  radarrStatus: {
    inRadarr: boolean;
    available: boolean;
    monitored: boolean;
  } | null;
}

function parseLimit(value: string | null): number {
  if (!value) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, parsed));
}

// GET /api/movies/upcoming - Fetch anticipated movies
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;
  const limit = parseLimit(req.nextUrl.searchParams.get("limit"));

  try {
    // Fetch anticipated movies from Trakt
    const anticipated = await getAnticipatedMovies(limit * 2);

    // Get user's household
    const householdMember = await prisma.householdMember.findFirst({
      where: { userId },
      select: { householdId: true },
    });

    const householdUserIds = householdMember
      ? (
          await prisma.householdMember.findMany({
            where: { householdId: householdMember.householdId },
            select: { userId: true },
          })
        ).map((m) => m.userId)
      : [userId];

    const results: UpcomingMovieResponse[] = [];

    for (const item of anticipated.slice(0, limit)) {
      const traktMovie = item.movie;
      const imdbId = traktMovie.ids?.imdb;
      const tmdbId = traktMovie.ids?.tmdb?.toString() || null;

      if (!imdbId) continue;

      // Check if movie exists in DB
      let movie = await prisma.movie.findUnique({
        where: { imdbId },
        include: {
          cast: {
            include: { person: { select: { name: true } } },
            orderBy: { castOrder: "asc" },
            take: 3,
          },
          crew: {
            where: { job: "Director" },
            include: { person: { select: { name: true } } },
            take: 2,
          },
          studios: {
            include: { studio: { select: { name: true } } },
            take: 2,
          },
          ratings: {
            where: { userId: { in: householdUserIds } },
            select: {
              userId: true,
              rating: true,
              notHeardOf: true,
            },
          },
          radarrSync: true,
        },
      });

      // Fetch OMDB details for poster/metadata
      const omdbDetails = await getOMDBMovie(imdbId);

      // Create or update movie in DB
      if (!movie) {
        movie = await prisma.movie.create({
          data: {
            imdbId,
            tmdbId,
            traktSlug: traktMovie.ids?.slug || null,
            title: traktMovie.title,
            year: traktMovie.year || null,
            posterUrl:
              omdbDetails?.Poster && omdbDetails.Poster !== "N/A"
                ? omdbDetails.Poster
                : null,
            overview: omdbDetails?.Plot || null,
          },
          include: {
            cast: {
              include: { person: { select: { name: true } } },
              take: 3,
            },
            crew: {
              where: { job: "Director" },
              include: { person: { select: { name: true } } },
              take: 2,
            },
            studios: {
              include: { studio: { select: { name: true } } },
              take: 2,
            },
            ratings: {
              where: { userId: { in: householdUserIds } },
              select: {
                userId: true,
                rating: true,
                notHeardOf: true,
              },
            },
            radarrSync: true,
          },
        });

        // Sync metadata from OMDB
        if (omdbDetails) {
          await syncMovieMetadataFromOMDB(movie.id, omdbDetails);
        }
      } else if (omdbDetails && !movie.posterUrl) {
        // Update missing poster
        await prisma.movie.update({
          where: { id: movie.id },
          data: {
            posterUrl:
              omdbDetails.Poster !== "N/A" ? omdbDetails.Poster : null,
          },
        });
        movie.posterUrl =
          omdbDetails.Poster !== "N/A" ? omdbDetails.Poster : null;
      }

      // Calculate consensus
      const validRatings = movie.ratings.filter(
        (r) => !r.notHeardOf && r.rating !== null
      );
      const userRating = movie.ratings.find((r) => r.userId === userId);
      const averageRating =
        validRatings.length > 0
          ? validRatings.reduce((sum, r) => sum + (r.rating || 0), 0) /
            validRatings.length
          : null;

      results.push({
        id: movie.id,
        imdbId: movie.imdbId,
        tmdbId: movie.tmdbId,
        title: movie.title,
        year: movie.year,
        posterUrl: movie.posterUrl,
        overview: movie.overview,
        releaseDate: movie.releaseDate?.toISOString() || null,
        listCount: item.list_count,
        actors: movie.cast.map((c) => c.person.name).filter(Boolean),
        directors: movie.crew.map((c) => c.person.name).filter(Boolean),
        studios: movie.studios.map((s) => s.studio.name).filter(Boolean),
        consensus: {
          ratingCount: validRatings.length,
          averageRating,
          userRating: userRating?.rating || null,
        },
        radarrStatus: movie.radarrSync
          ? {
              inRadarr: true,
              available: movie.radarrSync.available,
              monitored: movie.radarrSync.monitored,
            }
          : null,
      });
    }

    return NextResponse.json(results);
  } catch (error) {
    console.error("Error fetching upcoming movies:", error);
    return NextResponse.json(
      { error: "Failed to fetch upcoming movies" },
      { status: 500 }
    );
  }
}

// POST /api/movies/upcoming/sync-radarr - Sync consensus movies to Radarr
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Only admins can trigger Radarr sync
  const isAdmin = await isUserHouseholdAdmin(session.user.id);
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { movieIds } = await req.json();

    if (!Array.isArray(movieIds) || movieIds.length === 0) {
      return NextResponse.json(
        { error: "Movie IDs required" },
        { status: 400 }
      );
    }

    const results = await syncMoviesToRadarr(movieIds);

    return NextResponse.json({ results });
  } catch (error) {
    console.error("Error syncing to Radarr:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to sync to Radarr",
      },
      { status: 500 }
    );
  }
}
