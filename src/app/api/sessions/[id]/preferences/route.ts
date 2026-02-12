import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveSessionActor } from "@/lib/session-access";

const ALLOWED_ERA_PREFERENCES = new Set([
  "new_release",
  "modern_classic",
  "classic",
]);
const MIN_RELEASE_YEAR = 1900;
const MAX_RELEASE_YEAR = new Date().getFullYear() + 1;

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
  const minReleaseYear =
    typeof body?.minReleaseYear === "number"
      ? Math.trunc(body.minReleaseYear)
      : undefined;
  const maxReleaseYear =
    typeof body?.maxReleaseYear === "number"
      ? Math.trunc(body.maxReleaseYear)
      : undefined;
  const okWithRewatch =
    typeof body?.okWithRewatch === "boolean" ? body.okWithRewatch : undefined;

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
  const hasAnyYearRange =
    minReleaseYear !== undefined || maxReleaseYear !== undefined;
  if (hasAnyYearRange && (minReleaseYear === undefined || maxReleaseYear === undefined)) {
    return NextResponse.json(
      { error: "Both minReleaseYear and maxReleaseYear are required" },
      { status: 400 }
    );
  }
  if (
    hasAnyYearRange &&
    (minReleaseYear! < MIN_RELEASE_YEAR ||
      maxReleaseYear! > MAX_RELEASE_YEAR ||
      minReleaseYear! > maxReleaseYear!)
  ) {
    return NextResponse.json(
      {
        error: `Release year range must be between ${MIN_RELEASE_YEAR} and ${MAX_RELEASE_YEAR}`,
      },
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
    // Build participant update data
    const participantUpdateData: {
      eraPreference?: string | null;
      minReleaseYear?: number;
      maxReleaseYear?: number;
      okWithRewatch?: boolean;
    } = {};

    if (eraPreference !== undefined) {
      participantUpdateData.eraPreference = eraPreference;
    }
    if (hasAnyYearRange) {
      participantUpdateData.minReleaseYear = minReleaseYear;
      participantUpdateData.maxReleaseYear = maxReleaseYear;
    }
    if (okWithRewatch !== undefined) {
      participantUpdateData.okWithRewatch = okWithRewatch;
    }

    // Update participant preferences if any data to update
    if (Object.keys(participantUpdateData).length > 0) {
      await tx.sessionParticipant.update({
        where: {
          sessionId_userId: {
            sessionId,
            userId,
          },
        },
        data: participantUpdateData,
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
