import { NextResponse } from "next/server";
import { isInternalOrAdmin } from "@/lib/internal-auth";
import { prisma } from "@/lib/prisma";

const MIN_RADARR_AVG_RATING = 3.5;

export async function GET(request: Request) {
  const allowed = await isInternalOrAdmin(request);
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [memberships, households] = await Promise.all([
    prisma.householdMember.findMany({
      select: { userId: true, householdId: true },
    }),
    prisma.household.findMany({
      select: { id: true, _count: { select: { members: true } } },
    }),
  ]);

  const userHouseholds = new Map<string, string[]>();
  for (const m of memberships) {
    const existing = userHouseholds.get(m.userId) ?? [];
    existing.push(m.householdId);
    userHouseholds.set(m.userId, existing);
  }

  const householdSizeById = new Map<string, number>();
  for (const h of households) {
    householdSizeById.set(h.id, h._count.members);
  }

  // Get users by ID for display names
  const users = await prisma.user.findMany({
    select: { id: true, name: true },
  });
  const userNameById = new Map<string, string>();
  for (const u of users) {
    userNameById.set(u.id, u.name);
  }

  // Get all movies not in Radarr that have at least one want-to-watch rating
  const movies = await prisma.movie.findMany({
    where: {
      tmdbId: { not: null },
      radarrSync: null,
      ratings: {
        some: {
          rating: { not: null },
          hasSeen: false,
        },
      },
    },
    include: {
      ratings: {
        where: {
          hasSeen: false,
        },
        select: { userId: true, rating: true, notHeardOf: true },
      },
    },
  });

  const results = movies
    .map((movie) => {
      // Group votes by household
      const votesByHousehold = new Map<
        string,
        { sum: number; count: number; voters: string[] }
      >();

      for (const rating of movie.ratings) {
        if (rating.rating === null) continue;
        const hIds = userHouseholds.get(rating.userId) ?? [];
        for (const hId of hIds) {
          const summary = votesByHousehold.get(hId) ?? {
            sum: 0,
            count: 0,
            voters: [],
          };
          summary.sum += rating.rating;
          summary.count += 1;
          summary.voters.push(userNameById.get(rating.userId) ?? rating.userId);
          votesByHousehold.set(hId, summary);
        }
      }

      // Find best household context
      let best: {
        householdSize: number;
        ratingCount: number;
        avgRating: number;
        voters: string[];
        quorumMet: boolean;
        ratingMet: boolean;
        votesNeeded: number;
      } | null = null;

      for (const [hId, summary] of votesByHousehold.entries()) {
        const householdSize = householdSizeById.get(hId) ?? 0;
        if (householdSize <= 0) continue;
        const quorumThreshold = Math.floor(householdSize / 2) + 1;
        const avgRating = summary.sum / summary.count;
        const quorumMet = summary.count >= quorumThreshold;
        const ratingMet = avgRating >= MIN_RADARR_AVG_RATING;
        const votesNeeded = Math.max(0, quorumThreshold - summary.count);

        if (
          !best ||
          (quorumMet && ratingMet && !best.quorumMet) ||
          (quorumMet && ratingMet && best.quorumMet && avgRating > best.avgRating) ||
          (!best.quorumMet && !best.ratingMet && votesNeeded < best.votesNeeded)
        ) {
          best = {
            householdSize,
            ratingCount: summary.count,
            avgRating: Math.round(avgRating * 100) / 100,
            voters: summary.voters,
            quorumMet,
            ratingMet,
            votesNeeded,
          };
        }
      }

      if (!best) return null;

      return {
        title: movie.title,
        year: movie.year,
        avgRating: best.avgRating,
        votes: `${best.ratingCount}/${best.householdSize}`,
        votesNeeded: best.votesNeeded,
        voters: best.voters,
        quorumMet: best.quorumMet,
        ratingMet: best.ratingMet,
        ready: best.quorumMet && best.ratingMet,
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null)
    .sort((a, b) => {
      // Ready movies first, then by votes needed (asc), then by avg rating (desc)
      if (a.ready !== b.ready) return a.ready ? -1 : 1;
      if (a.votesNeeded !== b.votesNeeded) return a.votesNeeded - b.votesNeeded;
      return b.avgRating - a.avgRating;
    });

  return NextResponse.json({
    ready: results.filter((r) => r.ready),
    nearThreshold: results.filter((r) => !r.ready && r.votesNeeded <= 2),
    farther: results.filter((r) => !r.ready && r.votesNeeded > 2),
  });
}
