import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const ALLOWED_CONTEXTS = new Set(["discover", "upcoming", "session"]);

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const movieId = typeof body?.movieId === "string" ? body.movieId.trim() : "";
  const context = typeof body?.context === "string" ? body.context.trim().toLowerCase() : "";
  const message = typeof body?.message === "string" ? body.message.trim() : "";

  if (!movieId) {
    return NextResponse.json({ error: "Movie ID required" }, { status: 400 });
  }

  if (!ALLOWED_CONTEXTS.has(context)) {
    return NextResponse.json({ error: "Invalid feedback context" }, { status: 400 });
  }

  if (!message) {
    return NextResponse.json({ error: "Feedback message required" }, { status: 400 });
  }

  const safeMessage = message.slice(0, 500);

  await prisma.activityLog.create({
    data: {
      userId: session.user.id,
      action: `recommendation_feedback:${context}:${safeMessage}`,
      entityType: "movie",
      entityId: movieId,
    },
  });

  return NextResponse.json({ success: true });
}
