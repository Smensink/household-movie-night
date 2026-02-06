import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
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
  const userId = actor.userId;

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

  const body = await req.json().catch(() => null);
  const votes = Array.isArray(body?.votes)
    ? (body.votes as Array<{
        sessionMovieId?: unknown;
        rating?: unknown;
        willingToRewatch?: unknown;
      }>)
    : null;
  // votes: [{ sessionMovieId, rating, willingToRewatch }]

  if (!votes) {
    return NextResponse.json({ error: "Votes required" }, { status: 400 });
  }
  if (votes.length === 0) {
    return NextResponse.json({ error: "At least one vote is required" }, { status: 400 });
  }

  const normalizedVotes = votes.map((vote) => ({
    sessionMovieId:
      typeof vote?.sessionMovieId === "string" ? vote.sessionMovieId : "",
    rating: typeof vote?.rating === "number" ? vote.rating : NaN,
    willingToRewatch:
      typeof vote?.willingToRewatch === "boolean" ? vote.willingToRewatch : false,
  }));

  const hasInvalidVote = normalizedVotes.some(
    (vote) =>
      !vote.sessionMovieId ||
      Number.isNaN(vote.rating) ||
      vote.rating < 1 ||
      vote.rating > 5
  );
  if (hasInvalidVote) {
    return NextResponse.json(
      { error: "Each vote requires sessionMovieId and rating (1-5)" },
      { status: 400 }
    );
  }

  const uniqueVotes = Array.from(
    normalizedVotes.reduce((map, vote) => {
      map.set(vote.sessionMovieId, vote);
      return map;
    }, new Map<string, (typeof normalizedVotes)[number]>()).values()
  );

  const sessionMovieIds = uniqueVotes.map((vote) => vote.sessionMovieId);
  const validSessionMovies = await prisma.sessionMovie.findMany({
    where: {
      id: { in: sessionMovieIds },
      sessionId,
    },
    select: { id: true },
  });

  if (validSessionMovies.length !== sessionMovieIds.length) {
    return NextResponse.json(
      { error: "Votes contain invalid sessionMovieId values" },
      { status: 400 }
    );
  }

  await prisma.$transaction(
    uniqueVotes.map((vote) =>
      prisma.sessionVote.upsert({
        where: {
          sessionMovieId_userId: {
            sessionMovieId: vote.sessionMovieId,
            userId,
          },
        },
        create: {
          sessionMovieId: vote.sessionMovieId,
          userId,
          rating: vote.rating,
          willingToRewatch: vote.willingToRewatch,
        },
        update: {
          rating: vote.rating,
          willingToRewatch: vote.willingToRewatch,
        },
      })
    )
  );

  return NextResponse.json({ success: true });
}
