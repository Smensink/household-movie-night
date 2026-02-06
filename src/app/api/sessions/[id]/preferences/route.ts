import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveSessionActor } from "@/lib/session-access";

const ALLOWED_ERA_PREFERENCES = new Set([
  "new_release",
  "modern_classic",
  "classic",
]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params;
  const actor = await resolveSessionActor(req, sessionId);
  if (!actor) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const userId = actor.userId;

  const currentSession = await prisma.movieNightSession.findUnique({
    where: { id: sessionId },
    select: { status: true },
  });
  if (!currentSession) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  if (currentSession.status === "decided" || currentSession.status === "cancelled") {
    return NextResponse.json(
      { error: "Session is no longer active" },
      { status: 400 }
    );
  }

  const body = await req.json().catch(() => null);
  const eraPreference =
    body?.eraPreference === null
      ? null
      : typeof body?.eraPreference === "string"
      ? body.eraPreference
      : undefined;
  const genreRankings = Array.isArray(body?.genreRankings)
    ? (body.genreRankings as Array<{ genreId?: unknown; rank?: unknown }>)
    : undefined;

  if (
    eraPreference !== undefined &&
    eraPreference !== null &&
    !ALLOWED_ERA_PREFERENCES.has(eraPreference)
  ) {
    return NextResponse.json(
      { error: "Invalid eraPreference" },
      { status: 400 }
    );
  }

  const normalizedRankingsRaw =
    genreRankings?.map((g) => ({
      genreId: typeof g?.genreId === "string" ? g.genreId : "",
      rank: typeof g?.rank === "number" ? g.rank : NaN,
    })) ?? [];

  const hasInvalidRanking = normalizedRankingsRaw.some(
    (g) => !g.genreId || Number.isNaN(g.rank) || !Number.isInteger(g.rank) || g.rank <= 0
  );
  if (hasInvalidRanking) {
    return NextResponse.json(
      { error: "genreRankings must contain { genreId, rank } entries" },
      { status: 400 }
    );
  }

  const normalizedRankings = Array.from(
    normalizedRankingsRaw.reduce((map, ranking) => {
      map.set(ranking.genreId, ranking);
      return map;
    }, new Map<string, (typeof normalizedRankingsRaw)[number]>()).values()
  );

  await prisma.$transaction(async (tx) => {
    // Update era preference
    if (eraPreference !== undefined) {
      await tx.sessionParticipant.update({
        where: {
          sessionId_userId: {
            sessionId,
            userId,
          },
        },
        data: { eraPreference },
      });
    }

    // Save genre preferences for this session
    if (genreRankings) {
      await tx.sessionGenrePreference.deleteMany({
        where: { sessionId, userId },
      });

      if (normalizedRankings.length > 0) {
        await tx.sessionGenrePreference.createMany({
          data: normalizedRankings.map((g) => ({
            sessionId,
            userId,
            genreId: g.genreId,
            rank: g.rank,
          })),
        });
      }
    }
  });

  return NextResponse.json({ success: true });
}
