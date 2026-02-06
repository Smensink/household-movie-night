import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const memberships = await prisma.householdMember.findMany({
    where: { userId: session.user.id },
    select: { householdId: true },
  });

  const householdIds = memberships.map((m) => m.householdId);

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

  return NextResponse.json(sessions);
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { householdId, participantIds } = await req.json();

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
        userId: session.user.id,
        householdId,
      },
    },
  });

  if (!membership) {
    return NextResponse.json({ error: "Not a member" }, { status: 403 });
  }

  const movieNight = await prisma.movieNightSession.create({
    data: {
      householdId,
      participants: {
        create: (participantIds || [session.user.id]).map((id: string) => ({
          userId: id,
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
