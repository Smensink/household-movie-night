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

  const { id: sessionId } = await params;
  const { eraPreference, genreRankings } = await req.json();

  // Update era preference
  await prisma.sessionParticipant.updateMany({
    where: { sessionId, userId: session.user.id },
    data: { eraPreference },
  });

  // Save genre preferences for this session
  if (genreRankings && Array.isArray(genreRankings)) {
    await prisma.sessionGenrePreference.deleteMany({
      where: { sessionId, userId: session.user.id },
    });

    await prisma.sessionGenrePreference.createMany({
      data: genreRankings.map((g: { genreId: string; rank: number }) => ({
        sessionId,
        userId: session.user!.id!,
        genreId: g.genreId,
        rank: g.rank,
      })),
    });
  }

  return NextResponse.json({ success: true });
}
