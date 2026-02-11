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
    const existingParticipant = await prisma.sessionParticipant.findUnique({
      where: {
        sessionId_userId: {
          sessionId,
          userId: loggedInUserId,
        },
      },
      select: { id: true },
    });
    if (existingParticipant) {
      return { userId: loggedInUserId, isGuest: false };
    }

    const movieNightSession = await prisma.movieNightSession.findUnique({
      where: { id: sessionId },
      select: {
        householdId: true,
        status: true,
      },
    });
    if (!movieNightSession) {
      return null;
    }

    const householdMembership = await prisma.householdMember.findUnique({
      where: {
        userId_householdId: {
          userId: loggedInUserId,
          householdId: movieNightSession.householdId,
        },
      },
      select: { id: true },
    });
    if (!householdMembership) {
      return null;
    }

    if (
      movieNightSession.status === "gathering" ||
      movieNightSession.status === "voting"
    ) {
      await prisma.sessionParticipant.upsert({
        where: {
          sessionId_userId: {
            sessionId,
            userId: loggedInUserId,
          },
        },
        create: {
          sessionId,
          userId: loggedInUserId,
          okWithRewatch: false,
        },
        update: {},
      });

      return { userId: loggedInUserId, isGuest: false };
    }

    return null;
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
