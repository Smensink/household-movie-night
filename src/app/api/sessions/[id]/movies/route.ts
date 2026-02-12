import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getRecommendationsForSession } from "@/lib/recommendation";
import { resolveSessionActor } from "@/lib/session-access";

const sessionMovieInclude = {
  movie: {
    include: {
      genres: { include: { genre: true } },
      plexAvailability: true,
      radarrSync: true,
      cast: {
        include: { person: { select: { name: true } } },
        orderBy: { castOrder: "asc" as const },
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
      ratings: {
        select: { hasSeen: true, rating: true, notHeardOf: true },
      },
    },
  },
  votes: {
    include: { user: { select: { id: true, name: true } } },
  },
};

function parseBoundedInt(
  value: string | null,
  fallback: number,
  min: number,
  max: number
): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function fetchSessionMoviesForActor(sessionId: string, userId: string) {
  return prisma.sessionMovie.findMany({
    where: { sessionId },
    include: {
      ...sessionMovieInclude,
      movie: {
        ...sessionMovieInclude.movie,
        include: {
          ...sessionMovieInclude.movie.include,
          ratings: {
            where: { userId },
            select: { hasSeen: true, rating: true, notHeardOf: true },
          },
        },
      },
    },
  });
}

async function ensureSessionQueue({
  sessionId,
  userId,
  minQueue,
  replenishBatch,
}: {
  sessionId: string;
  userId: string;
  minQueue: number;
  replenishBatch: number;
}) {
  let sessionMovies = await fetchSessionMoviesForActor(sessionId, userId);

  const countUnrated = () =>
    sessionMovies.filter(
      (movie) => !movie.votes.some((vote) => vote.userId === userId)
    ).length;

  if (countUnrated() < minQueue) {
    const existingMovieIds = sessionMovies.map((movie) => movie.movieId);
    const needed = Math.max(minQueue - countUnrated(), 0) + replenishBatch;
    const recommendations = await getRecommendationsForSession(sessionId, needed, {
      activeUserId: userId,
      excludedMovieIds: existingMovieIds,
    });

    if (recommendations.length > 0) {
      await prisma.$transaction(
        recommendations.map((recommendation) =>
          prisma.sessionMovie.upsert({
            where: {
              sessionId_movieId: {
                sessionId,
                movieId: recommendation.movieId,
              },
            },
            create: {
              sessionId,
              movieId: recommendation.movieId,
            },
            update: {},
          })
        )
      );
      sessionMovies = await fetchSessionMoviesForActor(sessionId, userId);
    }
  }

  const unratedMovies = sessionMovies.filter(
    (movie) => !movie.votes.some((vote) => vote.userId === userId)
  );

  if (unratedMovies.length === 0) {
    return { all: sessionMovies, queue: [] as typeof sessionMovies };
  }

  const scoredQueue = await getRecommendationsForSession(
    sessionId,
    unratedMovies.length,
    {
      activeUserId: userId,
      includeExistingSessionMovies: true,
      forceMovieIds: unratedMovies.map((movie) => movie.movieId),
    }
  );
  const rankByMovieId = new Map(
    scoredQueue.map((movie, index) => [movie.movieId, index])
  );
  const queue = [...unratedMovies].sort((a, b) => {
    const rankA = rankByMovieId.get(a.movieId) ?? Number.MAX_SAFE_INTEGER;
    const rankB = rankByMovieId.get(b.movieId) ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    return a.movie.title.localeCompare(b.movie.title);
  });

  return { all: sessionMovies, queue };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params;
  const actor = await resolveSessionActor(req, sessionId);
  if (!actor) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const mode = req.nextUrl.searchParams.get("mode");
  if (mode === "queue") {
    const minQueue = parseBoundedInt(
      req.nextUrl.searchParams.get("minQueue"),
      6,
      1,
      24
    );
    const replenishBatch = parseBoundedInt(
      req.nextUrl.searchParams.get("replenishBatch"),
      6,
      1,
      24
    );
    const queueData = await ensureSessionQueue({
      sessionId,
      userId: actor.userId,
      minQueue,
      replenishBatch,
    });
    return NextResponse.json(queueData.queue);
  }

  const sessionMovies = await fetchSessionMoviesForActor(sessionId, actor.userId);
  return NextResponse.json(sessionMovies);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params;
  const actor = await resolveSessionActor(req, sessionId);
  if (!actor) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const currentSession = await prisma.movieNightSession.findUnique({
    where: { id: sessionId },
    select: { status: true },
  });
  if (!currentSession) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  if (currentSession.status === "decided" || currentSession.status === "cancelled") {
    return NextResponse.json(
      { error: "Session is no longer active" },
      { status: 400 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const requestedCount = parseBoundedInt(
    typeof body?.count === "number" ? String(body.count) : null,
    8,
    1,
    30
  );
  const minQueue = parseBoundedInt(
    typeof body?.minQueue === "number" ? String(body.minQueue) : null,
    6,
    1,
    24
  );
  const replenishBatch = parseBoundedInt(
    typeof body?.replenishBatch === "number" ? String(body.replenishBatch) : null,
    6,
    1,
    24
  );

  const existingSessionMovies = await prisma.sessionMovie.findMany({
    where: { sessionId },
    select: { movieId: true },
  });
  const recommendations = await getRecommendationsForSession(sessionId, requestedCount, {
    activeUserId: actor.userId,
    excludedMovieIds: existingSessionMovies.map((movie) => movie.movieId),
  });

  // Add to session
  const created = [];
  for (const rec of recommendations) {
    const sm = await prisma.sessionMovie.upsert({
      where: {
        sessionId_movieId: { sessionId, movieId: rec.movieId },
      },
      create: {
        sessionId,
        movieId: rec.movieId,
      },
      update: {},
      include: {
        ...sessionMovieInclude,
        movie: {
          ...sessionMovieInclude.movie,
          include: {
            ...sessionMovieInclude.movie.include,
            ratings: {
              where: { userId: actor.userId },
              select: { hasSeen: true, rating: true, notHeardOf: true },
            },
          },
        },
      },
    });
    created.push(sm);
  }

  // Update session status to voting
  await prisma.movieNightSession.update({
    where: { id: sessionId },
    data: { status: "voting" },
  });

  const queueData = await ensureSessionQueue({
    sessionId,
    userId: actor.userId,
    minQueue,
    replenishBatch,
  });

  return NextResponse.json(queueData.queue.length > 0 ? queueData.queue : created);
}
