import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { inviteCode } = await req.json();
  if (!inviteCode) {
    return NextResponse.json({ error: "Invite code required" }, { status: 400 });
  }

  const household = await prisma.household.findUnique({
    where: { inviteCode },
  });

  if (!household) {
    return NextResponse.json({ error: "Invalid invite code" }, { status: 404 });
  }

  const existing = await prisma.householdMember.findUnique({
    where: {
      userId_householdId: {
        userId: session.user.id,
        householdId: household.id,
      },
    },
  });

  if (existing) {
    return NextResponse.json({ error: "Already a member" }, { status: 409 });
  }

  await prisma.householdMember.create({
    data: {
      userId: session.user.id,
      householdId: household.id,
    },
  });

  return NextResponse.json({ success: true, household });
}
