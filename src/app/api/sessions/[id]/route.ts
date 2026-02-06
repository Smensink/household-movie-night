import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveSessionActor } from "@/lib/session-access";
import { auth } from "@/lib/auth";
import { isUserAdminForHousehold } from "@/lib/household-admin";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params;
  const actor = await resolveSessionActor(req, sessionId);
  if (!actor) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const loggedIn = await auth();
  const loggedInUserId = loggedIn?.user?.id ?? null;

  const movieNightSession = await prisma.movieNightSession.findUnique({
    where: { id: sessionId },
    include: {
      participants: {
        include: {
          user: { select: { id: true, name: true } },
        },
      },
    },
  });

  if (!movieNightSession) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const viewerIsAdmin = loggedInUserId
    ? await isUserAdminForHousehold(loggedInUserId, movieNightSession.householdId)
    : false;
  const canManage =
    Boolean(loggedInUserId) &&
    (viewerIsAdmin || movieNightSession.createdByUserId === loggedInUserId);

  return NextResponse.json({
    ...movieNightSession,
    canManage,
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params;
  const loggedIn = await auth();
  const userId = loggedIn?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const movieNightSession = await prisma.movieNightSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      status: true,
      householdId: true,
      createdByUserId: true,
    },
  });

  if (!movieNightSession) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (movieNightSession.status === "cancelled") {
    return NextResponse.json({ success: true });
  }

  const viewerIsAdmin = await isUserAdminForHousehold(
    userId,
    movieNightSession.householdId
  );
  const canManage =
    viewerIsAdmin || movieNightSession.createdByUserId === userId;

  if (!canManage) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await prisma.movieNightSession.update({
    where: { id: sessionId },
    data: {
      status: "cancelled",
    },
  });

  return NextResponse.json({ success: true });
}
