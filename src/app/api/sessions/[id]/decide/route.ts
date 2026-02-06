import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { decideMovie } from "@/lib/recommendation";
import { resolveSessionActor } from "@/lib/session-access";

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
  if (currentSession.status === "decided") {
    return NextResponse.json(
      { error: "Session already decided" },
      { status: 409 }
    );
  }

  const result = await decideMovie(sessionId);

  if (!result) {
    return NextResponse.json(
      { error: "No votes yet" },
      { status: 400 }
    );
  }

  return NextResponse.json({
    movie: result.movie,
    score: result.score,
    minRating: result.minRating,
  });
}
