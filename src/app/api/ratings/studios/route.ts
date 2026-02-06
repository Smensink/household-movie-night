import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ensureDefaultStudios } from "@/lib/default-catalog";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await ensureDefaultStudios();

  const studios = await prisma.studio.findMany({
    orderBy: { name: "asc" },
  });

  const ratings = await prisma.studioRating.findMany({
    where: { userId: session.user.id },
  });

  return NextResponse.json({
    studios,
    ratings: ratings.reduce(
      (acc, r) => ({
        ...acc,
        [r.studioId]: { rating: r.rating, notHeardOf: r.notHeardOf },
      }),
      {} as Record<string, { rating: number | null; notHeardOf: boolean }>
    ),
  });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await ensureDefaultStudios();

  const body = await req.json().catch(() => null);
  const studioId = typeof body?.studioId === "string" ? body.studioId : "";
  const rating = typeof body?.rating === "number" ? body.rating : null;
  const notHeardOf = Boolean(body?.notHeardOf);

  if (!studioId) {
    return NextResponse.json({ error: "Studio ID required" }, { status: 400 });
  }

  if (!notHeardOf && (rating === null || rating < 1 || rating > 5)) {
    return NextResponse.json(
      { error: "Rating must be between 1 and 5" },
      { status: 400 }
    );
  }

  const studioRating = await prisma.studioRating.upsert({
    where: {
      userId_studioId: { userId: session.user.id, studioId },
    },
    create: {
      userId: session.user.id,
      studioId,
      rating: notHeardOf ? null : rating,
      notHeardOf: notHeardOf ?? false,
    },
    update: {
      rating: notHeardOf ? null : rating,
      notHeardOf: notHeardOf ?? false,
    },
  });

  return NextResponse.json(studioRating);
}
