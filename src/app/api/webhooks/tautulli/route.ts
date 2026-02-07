import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { addNextTopRatedToRadarr } from "@/lib/api/radarr";

/**
 * Tautulli Webhook Endpoint
 *
 * Configure Tautulli to send webhooks to this endpoint when a movie finishes playing.
 *
 * In Tautulli:
 * 1. Go to Settings > Notification Agents
 * 2. Add a new Webhook agent
 * 3. Set Webhook URL to: https://your-domain/api/webhooks/tautulli
 * 4. Set Webhook Method to: POST
 * 5. Under Triggers, enable "Playback Stop"
 * 6. Under Conditions, set: Media Type is movie AND Watched Percent >= 80
 * 7. In Data > JSON Data, use:
 *    {
 *      "event": "media.stop",
 *      "media_type": "{media_type}",
 *      "title": "{title}",
 *      "year": "{year}",
 *      "imdb_id": "{imdb_id}",
 *      "tmdb_id": "{themoviedb_id}",
 *      "watched_percent": "{progress_percent}",
 *      "user": "{user}"
 *    }
 */

interface TautulliPayload {
  event?: string;
  media_type?: string;
  title?: string;
  year?: string;
  imdb_id?: string;
  tmdb_id?: string;
  watched_percent?: string;
  user?: string;
}

export async function POST(req: NextRequest) {
  let payload: TautulliPayload;

  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Only process movie stop events
  if (payload.media_type !== "movie") {
    return NextResponse.json({ message: "Ignored: not a movie" });
  }

  // Check if movie was actually watched (>= 80%)
  const watchedPercent = parseInt(payload.watched_percent || "0", 10);
  if (watchedPercent < 80) {
    return NextResponse.json({ message: "Ignored: not fully watched" });
  }

  const imdbId = payload.imdb_id;
  const tmdbId = payload.tmdb_id;
  const title = payload.title || "Unknown";

  console.log(`[Tautulli] Movie watched: "${title}" (IMDB: ${imdbId}, TMDB: ${tmdbId})`);

  // Find the movie in our database
  let movie = null;
  if (imdbId) {
    movie = await prisma.movie.findUnique({
      where: { imdbId },
      include: { radarrSync: true },
    });
  }
  if (!movie && tmdbId) {
    movie = await prisma.movie.findUnique({
      where: { tmdbId },
      include: { radarrSync: true },
    });
  }

  if (!movie) {
    console.log(`[Tautulli] Movie not found in database: "${title}"`);
    return NextResponse.json({ message: "Movie not in database" });
  }

  // Update Radarr sync to mark as available (since it was watched)
  if (movie.radarrSync) {
    await prisma.radarrSync.update({
      where: { movieId: movie.id },
      data: { available: true },
    });
  }

  // Mark movie as seen for all users who had it in their watchlist
  const unsawRatings = await prisma.movieRating.findMany({
    where: {
      movieId: movie.id,
      hasSeen: false,
      rating: { not: null },
    },
  });

  if (unsawRatings.length > 0) {
    await prisma.movieRating.updateMany({
      where: {
        movieId: movie.id,
        hasSeen: false,
      },
      data: { hasSeen: true },
    });
    console.log(`[Tautulli] Marked ${unsawRatings.length} users as having seen "${title}"`);
  }

  // Add the next highest-rated movie to Radarr
  const addResult = await addNextTopRatedToRadarr();

  if (addResult.success && addResult.movie) {
    console.log(`[Tautulli] Added next movie to Radarr: "${addResult.movie.title}" (avg rating: ${addResult.movie.avgRating})`);
    return NextResponse.json({
      message: `Watched "${title}", added "${addResult.movie.title}" to Radarr`,
      watchedMovie: { id: movie.id, title: movie.title },
      addedMovie: addResult.movie,
    });
  }

  return NextResponse.json({
    message: `Watched "${title}", no new movies to add`,
    watchedMovie: { id: movie.id, title: movie.title },
    addResult,
  });
}

// GET endpoint for testing/verification
export async function GET() {
  return NextResponse.json({
    status: "ok",
    message: "Tautulli webhook endpoint is active",
    instructions: {
      webhook_url: "/api/webhooks/tautulli",
      method: "POST",
      trigger: "Playback Stop",
      condition: "Media Type is movie AND Watched Percent >= 80",
      json_data: {
        event: "media.stop",
        media_type: "{media_type}",
        title: "{title}",
        year: "{year}",
        imdb_id: "{imdb_id}",
        tmdb_id: "{themoviedb_id}",
        watched_percent: "{progress_percent}",
        user: "{user}",
      },
    },
  });
}
