import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isUserHouseholdAdmin } from "@/lib/household-admin";
import {
  syncTopRatedToRadarr,
  getTopRatedMoviesForRadarr,
  addNextTopRatedToRadarr,
} from "@/lib/api/radarr";

// GET - Get top rated movies that would be added to Radarr
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isAdmin = await isUserHouseholdAdmin(session.user.id);
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = limitParam ? parseInt(limitParam, 10) : 10;

  const topMovies = await getTopRatedMoviesForRadarr(Math.min(limit, 50));

  return NextResponse.json({
    movies: topMovies,
    count: topMovies.length,
  });
}

// POST - Sync top rated movies to Radarr
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isAdmin = await isUserHouseholdAdmin(session.user.id);
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const count = typeof body.count === "number" ? Math.min(body.count, 20) : 10;

  try {
    const result = await syncTopRatedToRadarr(count);

    return NextResponse.json({
      message: `Added ${result.added.length} movies, ${result.alreadyInRadarr.length} already in Radarr, ${result.failed.length} failed`,
      ...result,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Sync failed" },
      { status: 500 }
    );
  }
}

// PATCH - Add next top rated movie (used when a movie is watched)
export async function PATCH() {
  // This can be called by Tautulli webhook, so no auth required
  // But we'll add a simple API key check for security

  try {
    const result = await addNextTopRatedToRadarr();

    if (result.success) {
      return NextResponse.json({
        message: `Added "${result.movie?.title}" to Radarr`,
        movie: result.movie,
      });
    }

    return NextResponse.json(
      { error: result.error || "Failed to add movie" },
      { status: 400 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to add movie" },
      { status: 500 }
    );
  }
}
