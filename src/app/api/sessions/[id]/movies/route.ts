import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getRecommendationsForSession } from "@/lib/recommendation";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: sessionId } = await params;

  // Get existing session movies with votes
  const sessionMovies = await prisma.sessionMovie.findMany({
    where: { sessionId },
    include: {
      movie: {
        include: {
          genres: { include: { genre: true } },
          plexAvailability: true,
          radarrSync: true,
        },
      },
      votes: {
        include: { user: { select: { id: true, name: true } } },
      },
    },
  });

  return NextResponse.json(sessionMovies);
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: sessionId } = await params;

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
        movie: {
          include: {
            genres: { include: { genre: true } },
            plexAvailability: true,
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
