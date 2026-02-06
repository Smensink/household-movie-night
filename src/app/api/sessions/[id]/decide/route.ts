import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { decideMovie } from "@/lib/recommendation";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: sessionId } = await params;
  const result = await decideMovie(sessionId);

  if (!result) {
    return NextResponse.json(
      { error: "No votes yet" },
      { status: 400 }
    );
  }

  return NextResponse.json({
    movie: result.movie,
    score: result.score,
    minRating: result.minRating,
  });
}
