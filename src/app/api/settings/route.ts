import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isUserHouseholdAdmin } from "@/lib/household-admin";

const ALLOWED_DISCOVERY_SOURCE_PREFS = new Set([
  "trending",
  "popular",
  "top_rated",
  "new_releases",
  "indie_darlings",
  "balanced",
]);

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

  return NextResponse.json({
    ...settings,
    isAdmin: await isUserHouseholdAdmin(session.user.id),
  });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const explorationFactor =
    typeof body?.explorationFactor === "number"
      ? body.explorationFactor
      : undefined;
  const discoverySourcePref =
    typeof body?.discoverySourcePref === "string"
      ? body.discoverySourcePref
      : undefined;

  if (
    explorationFactor !== undefined &&
    (Number.isNaN(explorationFactor) ||
      explorationFactor < 0 ||
      explorationFactor > 1)
  ) {
    return NextResponse.json(
      { error: "explorationFactor must be between 0 and 1" },
      { status: 400 }
    );
  }

  if (
    discoverySourcePref !== undefined &&
    !ALLOWED_DISCOVERY_SOURCE_PREFS.has(discoverySourcePref)
  ) {
    return NextResponse.json(
      { error: "Invalid discoverySourcePref" },
      { status: 400 }
    );
  }

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
