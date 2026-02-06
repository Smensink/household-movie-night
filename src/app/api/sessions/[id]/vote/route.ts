import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id: _sessionId } = await params;
  const { votes } = await req.json();
  // votes: [{ sessionMovieId, rating, willingToRewatch }]

  if (!votes || !Array.isArray(votes)) {
    return NextResponse.json({ error: "Votes required" }, { status: 400 });
  }

  for (const vote of votes) {
    await prisma.sessionVote.upsert({
      where: {
        sessionMovieId_userId: {
          sessionMovieId: vote.sessionMovieId,
          userId: session.user.id,
        },
      },
      create: {
        sessionMovieId: vote.sessionMovieId,
        userId: session.user.id,
        rating: vote.rating,
        willingToRewatch: vote.willingToRewatch ?? false,
      },
      update: {
        rating: vote.rating,
        willingToRewatch: vote.willingToRewatch ?? false,
      },
    });
  }

  return NextResponse.json({ success: true });
}
