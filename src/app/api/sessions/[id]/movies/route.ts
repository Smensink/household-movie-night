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
        select: { hasSeen: true },
      },
    },
  },
  votes: {
    include: { user: { select: { id: true, name: true } } },
  },
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params;
  const actor = await resolveSessionActor(req, sessionId);
  if (!actor) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Get existing session movies with votes
  const sessionMovies = await prisma.sessionMovie.findMany({
    where: { sessionId },
    include: {
      ...sessionMovieInclude,
      movie: {
        ...sessionMovieInclude.movie,
        include: {
          ...sessionMovieInclude.movie.include,
          ratings: {
            where: { userId: actor.userId },
            select: { hasSeen: true },
          },
        },
      },
    },
  });

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

  // Generate recommendations
  const recommendations = await getRecommendationsForSession(sessionId, 8);

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
              select: { hasSeen: true },
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

  return NextResponse.json(created);
}
