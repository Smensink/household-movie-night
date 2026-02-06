import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const genres = await prisma.genre.findMany({
    orderBy: { name: "asc" },
  });

  const rankings = await prisma.genreRanking.findMany({
    where: { userId: session.user.id },
  });

  return NextResponse.json({
    genres,
    rankings: rankings.reduce(
      (acc, r) => ({ ...acc, [r.genreId]: r.rank }),
      {} as Record<string, number>
    ),
  });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { rankings } = await req.json();
  // rankings: { genreId: rank }[]

  if (!rankings || !Array.isArray(rankings)) {
    return NextResponse.json({ error: "Rankings required" }, { status: 400 });
  }

  // Delete old rankings and create new
  await prisma.genreRanking.deleteMany({
    where: { userId: session.user.id },
  });

  await prisma.genreRanking.createMany({
    data: rankings.map((r: { genreId: string; rank: number }) => ({
      userId: session.user!.id!,
      genreId: r.genreId,
      rank: r.rank,
    })),
  });

  return NextResponse.json({ success: true });
}
