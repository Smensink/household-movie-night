import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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

  const { movieId, rating, hasSeen, notHeardOf } = await req.json();

  if (!movieId) {
    return NextResponse.json({ error: "Movie ID required" }, { status: 400 });
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

  return NextResponse.json(movieRating);
}
