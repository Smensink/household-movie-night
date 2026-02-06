import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  DEFAULT_ALGORITHM_SETTINGS,
  getAlgorithmSettings,
  saveAlgorithmSettings,
} from "@/lib/algorithm-settings";
import { isUserHouseholdAdmin } from "@/lib/household-admin";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isAdmin = await isUserHouseholdAdmin(session.user.id);
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const settings = await getAlgorithmSettings();
  return NextResponse.json(settings);
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isAdmin = await isUserHouseholdAdmin(session.user.id);
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "Valid settings payload required" },
      { status: 400 }
    );
  }

  const saved = await saveAlgorithmSettings(body);
  return NextResponse.json(saved);
}

export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isAdmin = await isUserHouseholdAdmin(session.user.id);
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const saved = await saveAlgorithmSettings(DEFAULT_ALGORITHM_SETTINGS);
  return NextResponse.json(saved);
}
