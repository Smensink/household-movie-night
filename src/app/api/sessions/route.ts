import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const memberships = await prisma.householdMember.findMany({
    where: { userId },
    select: { householdId: true, role: true },
  });

  const householdIds = memberships.map((membership) => membership.householdId);
  const roleByHouseholdId = new Map(
    memberships.map((membership) => [membership.householdId, membership.role])
  );

  const sessions = await prisma.movieNightSession.findMany({
    where: { householdId: { in: householdIds } },
    include: {
      household: true,
      participants: {
        include: { user: { select: { id: true, name: true } } },
      },
      movies: {
        include: {
          movie: true,
          votes: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  return NextResponse.json(
    sessions.map((movieNightSession) => {
      const viewerRole =
        roleByHouseholdId.get(movieNightSession.householdId) ?? "member";
      const isParticipant = movieNightSession.participants.some(
        (participant) => participant.user.id === userId
      );
      const canManage =
        viewerRole === "admin" || movieNightSession.createdByUserId === userId;

      return {
        ...movieNightSession,
        viewerRole,
        isParticipant,
        canManage,
      };
    })
  );
}

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const householdId =
    typeof body?.householdId === "string" ? body.householdId : "";
  const participantIds = Array.isArray(body?.participantIds)
    ? (body.participantIds as unknown[])
    : [];

  if (!householdId) {
    return NextResponse.json(
      { error: "Household ID required" },
      { status: 400 }
    );
  }

  // Verify user is a member
  const membership = await prisma.householdMember.findUnique({
    where: {
      userId_householdId: {
        userId,
        householdId,
      },
    },
  });

  if (!membership) {
    return NextResponse.json({ error: "Not a member" }, { status: 403 });
  }

  const householdMembers = await prisma.householdMember.findMany({
    where: { householdId },
    select: { userId: true },
  });
  const validMemberIds = new Set(householdMembers.map((m) => m.userId));

  const requestedParticipantIds = participantIds.filter(
    (id): id is string => typeof id === "string" && id.length > 0
  );
  const invalidParticipantIds = requestedParticipantIds.filter(
    (id) => !validMemberIds.has(id)
  );
  if (invalidParticipantIds.length > 0) {
    return NextResponse.json(
      { error: "participantIds contains users outside the household" },
      { status: 400 }
    );
  }

  const finalParticipantIds = Array.from(
    new Set([...requestedParticipantIds, userId])
  );

  const movieNight = await prisma.movieNightSession.create({
    data: {
      householdId,
      createdByUserId: userId,
      participants: {
        create: finalParticipantIds.map((id) => ({
          userId: id,
          okWithRewatch: false,
        })),
      },
    },
    include: {
      participants: {
        include: { user: { select: { id: true, name: true } } },
      },
    },
  });

  return NextResponse.json(movieNight);
}
