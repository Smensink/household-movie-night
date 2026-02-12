import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ensureDefaultGenres } from "@/lib/default-catalog";

export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  await ensureDefaultGenres();

  const genres = await prisma.genre.findMany({
    orderBy: { name: "asc" },
  });

  if (!userId) {
    return NextResponse.json({ genres, rankings: {} });
  }

  const rankings = await prisma.genreRanking.findMany({ where: { userId } });

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
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await ensureDefaultGenres();

  const body = await req.json().catch(() => null);
  const rankings = Array.isArray(body?.rankings)
    ? (body.rankings as Array<{ genreId?: unknown; rank?: unknown }>)
    : null;
  // rankings: { genreId: rank }[]

  if (!rankings) {
    return NextResponse.json({ error: "Rankings required" }, { status: 400 });
  }

  const normalizedRankingsRaw = rankings.map((r) => ({
    genreId: typeof r?.genreId === "string" ? r.genreId : "",
    rank: typeof r?.rank === "number" ? r.rank : NaN,
  }));
  const hasInvalidRanking = normalizedRankingsRaw.some(
    (r) => !r.genreId || Number.isNaN(r.rank) || !Number.isInteger(r.rank) || r.rank <= 0
  );
  if (hasInvalidRanking) {
    return NextResponse.json(
      { error: "Each ranking requires { genreId, rank }" },
      { status: 400 }
    );
  }
  const normalizedRankings = Array.from(
    normalizedRankingsRaw.reduce((map, ranking) => {
      map.set(ranking.genreId, ranking);
      return map;
    }, new Map<string, (typeof normalizedRankingsRaw)[number]>()).values()
  );

  // Delete old rankings and create new
  await prisma.genreRanking.deleteMany({
    where: { userId },
  });

  await prisma.genreRanking.createMany({
    data: normalizedRankings.map((r) => ({
      userId,
      genreId: r.genreId,
      rank: r.rank,
    })),
  });

  return NextResponse.json({ success: true });
}
