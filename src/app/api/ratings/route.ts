import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logActivity } from "@/lib/matrix-factorization";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ratings = await prisma.movieRating.findMany({
    where: { userId: session.user.id },
    include: {
      movie: {
        include: {
          genres: { include: { genre: true } },
        },
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json(ratings);
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const movieId = typeof body?.movieId === "string" ? body.movieId : "";
  const rating = typeof body?.rating === "number" ? body.rating : null;
  const hasSeen = typeof body?.hasSeen === "boolean" ? body.hasSeen : false;
  const notHeardOf = Boolean(body?.notHeardOf);

  if (!movieId) {
    return NextResponse.json({ error: "Movie ID required" }, { status: 400 });
  }

  if (!notHeardOf && (rating === null || rating < 1 || rating > 5)) {
    return NextResponse.json(
      { error: "Rating must be between 1 and 5" },
      { status: 400 }
    );
  }

  const movieRating = await prisma.movieRating.upsert({
    where: {
      userId_movieId: { userId: session.user.id, movieId },
    },
    create: {
      userId: session.user.id,
      movieId,
      rating: notHeardOf ? null : rating,
      hasSeen: hasSeen ?? false,
      notHeardOf: notHeardOf ?? false,
    },
    update: {
      rating: notHeardOf ? null : rating,
      hasSeen: hasSeen ?? false,
      notHeardOf: notHeardOf ?? false,
    },
  });

  // Log activity for MF retraining trigger
  await logActivity(session.user.id, "rating", "movie", movieId);

  return NextResponse.json(movieRating);
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const movieId = req.nextUrl.searchParams.get("movieId")?.trim() || "";
  if (!movieId) {
    return NextResponse.json({ error: "Movie ID required" }, { status: 400 });
  }

  await prisma.movieRating.deleteMany({
    where: {
      userId: session.user.id,
      movieId,
    },
  });

  return NextResponse.json({ success: true });
}
