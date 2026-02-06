import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { verifyGuestToken } from "@/lib/guest-token";
import { prisma } from "@/lib/prisma";

export interface SessionActor {
  userId: string;
  isGuest: boolean;
}

export async function resolveSessionActor(
  req: NextRequest,
  sessionId: string
): Promise<SessionActor | null> {
  const loggedIn = await auth();
  const loggedInUserId = loggedIn?.user?.id;

  if (loggedInUserId) {
    const participant = await prisma.sessionParticipant.findUnique({
      where: {
        sessionId_userId: {
          sessionId,
          userId: loggedInUserId,
        },
      },
      select: { id: true },
    });
    if (!participant) {
      return null;
    }

    return { userId: loggedInUserId, isGuest: false };
  }

  const guestToken =
    req.headers.get("x-guest-token") ||
    req.nextUrl.searchParams.get("guestToken");
  if (!guestToken) {
    return null;
  }

  const payload = verifyGuestToken(guestToken);
  if (!payload || payload.sessionId !== sessionId) {
    return null;
  }

  const participant = await prisma.sessionParticipant.findUnique({
    where: {
      sessionId_userId: {
        sessionId,
        userId: payload.userId,
      },
    },
    include: { user: { select: { isGuest: true } } },
  });

  if (!participant || !participant.user.isGuest) {
    return null;
  }

  return { userId: payload.userId, isGuest: true };
}
