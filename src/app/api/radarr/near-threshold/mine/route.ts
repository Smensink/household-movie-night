import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const MIN_RADARR_AVG_RATING = 3.5;
const NEAR_VOTES_WINDOW = 2;
const NEAR_RATING_GAP = 0.6;

interface HouseholdCandidate {
  movieId: string;
  title: string;
  year: number | null;
  posterUrl: string | null;
  overview: string | null;
  avgRating: number;
  votesCount: number;
  householdSize: number;
  votesNeeded: number;
  ratingGap: number;
  ready: boolean;
  voters: string[];
  userRating: {
    rating: number | null;
    hasSeen: boolean;
    notHeardOf: boolean;
  } | null;
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const households = await prisma.household.findMany({
    where: {
      members: {
        some: { userId },
      },
    },
    select: {
      id: true,
      name: true,
      members: {
        select: {
          userId: true,
          user: {
            select: {
              name: true,
            },
          },
        },
      },
    },
  });

  if (households.length === 0) {
    return NextResponse.json({
      households: [],
      minAvgRating: MIN_RADARR_AVG_RATING,
    });
  }

  const allMemberIds = Array.from(
    new Set(
      households.flatMap((household) => household.members.map((member) => member.userId))
    )
  );

  const movies = await prisma.movie.findMany({
    where: {
      tmdbId: { not: null },
      radarrSync: null,
      ratings: {
        some: {
          userId: { in: allMemberIds },
          hasSeen: false,
          rating: { not: null },
        },
      },
    },
    include: {
      ratings: {
        where: {
          userId: { in: allMemberIds },
        },
        select: {
          userId: true,
          rating: true,
          hasSeen: true,
          notHeardOf: true,
        },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: 1000,
  });

  const householdSections = households
    .map((household) => {
      const memberIds = new Set(household.members.map((member) => member.userId));
      const memberNameById = new Map(
        household.members.map((member) => [member.userId, member.user.name || "Unknown"])
      );
      const householdSize = household.members.length;
      const quorumThreshold = Math.floor(householdSize / 2) + 1;

      const ready: HouseholdCandidate[] = [];
      const nearThreshold: HouseholdCandidate[] = [];

      for (const movie of movies) {
        const userHasAnyRating = movie.ratings.some((rating) => rating.userId === userId);
        if (userHasAnyRating) continue;

        const householdRatings = movie.ratings.filter(
          (rating) =>
            memberIds.has(rating.userId) &&
            !rating.hasSeen &&
            !rating.notHeardOf &&
            typeof rating.rating === "number"
        );

        if (householdRatings.length === 0) continue;

        const sum = householdRatings.reduce(
          (total, rating) => total + (rating.rating || 0),
          0
        );
        const avgRating = sum / householdRatings.length;
        const votesCount = householdRatings.length;
        const votesNeeded = Math.max(0, quorumThreshold - votesCount);
        const ratingGap = Math.max(0, MIN_RADARR_AVG_RATING - avgRating);
        const readyForRadarr = votesNeeded === 0 && ratingGap === 0;
        const isNearThreshold =
          !readyForRadarr &&
          (votesNeeded <= NEAR_VOTES_WINDOW ||
            (votesNeeded === 0 && ratingGap <= NEAR_RATING_GAP) ||
            (votesNeeded === 1 && ratingGap <= 1.0));

        if (!readyForRadarr && !isNearThreshold) continue;

        const voters = householdRatings
          .map((rating) => memberNameById.get(rating.userId) || "Unknown")
          .filter(Boolean);

        const candidate: HouseholdCandidate = {
          movieId: movie.id,
          title: movie.title,
          year: movie.year ?? null,
          posterUrl: movie.posterUrl ?? null,
          overview: movie.overview ?? null,
          avgRating: Math.round(avgRating * 100) / 100,
          votesCount,
          householdSize,
          votesNeeded,
          ratingGap: Math.round(ratingGap * 100) / 100,
          ready: readyForRadarr,
          voters,
          userRating: null,
        };

        if (readyForRadarr) {
          ready.push(candidate);
        } else {
          nearThreshold.push(candidate);
        }
      }

      const sortCandidates = (a: HouseholdCandidate, b: HouseholdCandidate) => {
        if (a.votesNeeded !== b.votesNeeded) return a.votesNeeded - b.votesNeeded;
        if (a.ratingGap !== b.ratingGap) return a.ratingGap - b.ratingGap;
        return b.avgRating - a.avgRating;
      };

      ready.sort(sortCandidates);
      nearThreshold.sort(sortCandidates);

      return {
        householdId: household.id,
        householdName: household.name,
        householdSize,
        quorumThreshold,
        nearThreshold,
        ready,
      };
    })
    .filter((household) => household.nearThreshold.length > 0);

  return NextResponse.json({
    households: householdSections,
    minAvgRating: MIN_RADARR_AVG_RATING,
    nearVotesWindow: NEAR_VOTES_WINDOW,
    nearRatingGap: NEAR_RATING_GAP,
  });
}
