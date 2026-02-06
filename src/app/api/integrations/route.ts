import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isUserHouseholdAdmin } from "@/lib/household-admin";

const ALLOWED_SERVICES = new Set(["radarr", "plex", "trakt", "omdb"]);

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isAdmin = await isUserHouseholdAdmin(session.user.id);
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const configs = await prisma.integrationConfig.findMany();
  // Don't expose API keys fully
  return NextResponse.json(
    configs.map((c) => ({
      ...c,
      apiKey: c.apiKey ? "••••" + c.apiKey.slice(-4) : null,
    }))
  );
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

  const body = await req.json();
  const service =
    typeof body.service === "string" ? body.service.trim().toLowerCase() : "";
  const baseUrl =
    typeof body.baseUrl === "string"
      ? body.baseUrl.trim() || null
      : body.baseUrl;
  const apiKey =
    typeof body.apiKey === "string" ? body.apiKey.trim() || null : body.apiKey;
  const enabled = typeof body.enabled === "boolean" ? body.enabled : undefined;

  if (!service) {
    return NextResponse.json({ error: "Service required" }, { status: 400 });
  }

  if (!ALLOWED_SERVICES.has(service)) {
    return NextResponse.json({ error: "Invalid service" }, { status: 400 });
  }

  const config = await prisma.integrationConfig.upsert({
    where: { service },
    create: { service, baseUrl, apiKey, enabled: enabled ?? false },
    update: {
      ...(baseUrl !== undefined && { baseUrl }),
      ...(apiKey !== undefined && { apiKey }),
      ...(enabled !== undefined && { enabled }),
    },
  });

  return NextResponse.json({
    ...config,
    apiKey: config.apiKey ? "••••" + config.apiKey.slice(-4) : null,
  });
}
