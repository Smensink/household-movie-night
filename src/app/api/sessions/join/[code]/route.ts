import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { v4 as uuidv4 } from "uuid";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const { name } = await req.json();

  const session = await prisma.movieNightSession.findUnique({
    where: { guestInviteCode: code },
  });

  if (!session) {
    return NextResponse.json({ error: "Invalid invite code" }, { status: 404 });
  }

  if (session.status === "decided" || session.status === "cancelled") {
    return NextResponse.json({ error: "Session has ended" }, { status: 400 });
  }

  // Create a guest user
  const guestUser = await prisma.user.create({
    data: {
      name: name || `Guest ${uuidv4().slice(0, 4)}`,
      isGuest: true,
    },
  });

  // Add to session
  await prisma.sessionParticipant.create({
    data: {
      sessionId: session.id,
      userId: guestUser.id,
    },
  });

  return NextResponse.json({
    userId: guestUser.id,
    sessionId: session.id,
    guestToken: guestUser.id, // Simple guest auth
  });
}
