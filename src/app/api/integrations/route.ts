import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

  const { service, baseUrl, apiKey, enabled } = await req.json();

  if (!service) {
    return NextResponse.json({ error: "Service required" }, { status: 400 });
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
