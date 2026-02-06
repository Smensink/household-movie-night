import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let settings = await prisma.userSettings.findUnique({
    where: { userId: session.user.id },
  });

  if (!settings) {
    settings = await prisma.userSettings.create({
      data: { userId: session.user.id },
    });
  }

  // Check if user is admin of any household
  const adminMembership = await prisma.householdMember.findFirst({
    where: { userId: session.user.id, role: "admin" },
  });

  return NextResponse.json({
    ...settings,
    isAdmin: !!adminMembership,
  });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { explorationFactor, discoverySourcePref } = await req.json();

  const settings = await prisma.userSettings.upsert({
    where: { userId: session.user.id },
    create: {
      userId: session.user.id,
      explorationFactor: explorationFactor ?? 0.5,
      discoverySourcePref: discoverySourcePref ?? "balanced",
    },
    update: {
      ...(explorationFactor !== undefined && { explorationFactor }),
      ...(discoverySourcePref !== undefined && { discoverySourcePref }),
    },
  });

  return NextResponse.json(settings);
}
