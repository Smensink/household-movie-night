import { prisma } from "./prisma";
import {
  averageAffinityForIds,
  buildGroupPreferenceProfile,
} from "./preference-profile";
import { getAlgorithmSettings } from "./algorithm-settings";
import { getPredictedRatingsForUser } from "./matrix-factorization";

interface ScoredMovie {
  movieId: string;
  title: string;
  score: number;
  posterUrl: string | null;
  year: number | null;
  era: string | null;
  available: boolean;
}

interface SessionRecommendationOptions {
  activeUserId?: string;
  includeExistingSessionMovies?: boolean;
  forceMovieIds?: string[];
  excludedMovieIds?: string[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeRating(rating: number): number {
  return (rating - 3) / 2;
}

function normalizeRank(rank: number): number {
  const bounded = clamp(rank, 1, 20);
  return (20 - bounded) / 19;
}

function normalizeFiveStarSignal(rating: number | null | undefined): number {
  if (typeof rating !== "number" || Number.isNaN(rating)) return 0;
  return clamp((rating - 3) / 2, -1, 1);
}

function deterministicJitter(seed: string, magnitude: number): number {
  if (magnitude <= 0) return 0;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const normalized = (hash % 1000) / 1000;
  return (normalized - 0.5) * 2 * magnitude;
}

export async function getRecommendationsForSession(
  sessionId: string,
  count = 10,
  options: SessionRecommendationOptions = {}
): Promise<ScoredMovie[]> {
  const session = await prisma.movieNightSession.findUnique({
    where: { id: sessionId },
    include: {
      participants: {
        select: {
          userId: true,
          minReleaseYear: true,
          maxReleaseYear: true,
          okWithRewatch: true,
          user: { select: { id: true, name: true } },
        },
      },
      genrePreferences: true,
    },
  });

  if (!session) return [];

  const participantIds = session.participants.map((participant) => participant.userId);
  if (participantIds.length === 0) return [];

  const profile = await buildGroupPreferenceProfile(participantIds);
  const algorithmSettings = await getAlgorithmSettings();
  const tuning = algorithmSettings.sessionRecommendation;

  const tonightGenreAccumulator = new Map<string, { total: number; count: number }>();
  for (const pref of session.genrePreferences) {
    const current = tonightGenreAccumulator.get(pref.genreId) ?? { total: 0, count: 0 };
    current.total += normalizeRank(pref.rank);
    current.count += 1;
    tonightGenreAccumulator.set(pref.genreId, current);
  }

  const tonightGenreScores = new Map<string, number>();
  for (const [genreId, values] of tonightGenreAccumulator) {
    tonightGenreScores.set(genreId, values.total / values.count);
  }

  const participantsWithYearRange = session.participants.filter(
    (participant) =>
      typeof participant.minReleaseYear === "number" &&
      typeof participant.maxReleaseYear === "number"
  );
  const participantById = new Map(
    session.participants.map((participant) => [participant.userId, participant])
  );

  // Track participants who don't want to rewatch movies
  const noRewatchParticipantIds = new Set(
    session.participants
      .filter((participant) => participant.okWithRewatch === false)
      .map((participant) => participant.userId)
  );

  const existingSessionMovies = await prisma.sessionMovie.findMany({
    where: { sessionId },
    select: {
      movieId: true,
      votes: {
        select: { userId: true, rating: true },
      },
    },
  });

  const sessionVotesByMovie = new Map(
    existingSessionMovies.map((movie) => [movie.movieId, movie.votes])
  );

  const excludedMovieIds = new Set<string>(options.excludedMovieIds ?? []);
  if (!options.forceMovieIds && !options.includeExistingSessionMovies) {
    for (const movie of existingSessionMovies) {
      excludedMovieIds.add(movie.movieId);
    }
  }

  const forceMovieIds = Array.isArray(options.forceMovieIds)
    ? options.forceMovieIds.filter((id) => typeof id === "string" && id.length > 0)
    : [];
  const hasForcedMovieFilter = forceMovieIds.length > 0;

  // Only show movies that are available on Plex or Radarr (with file)
  const movies = await prisma.movie.findMany({
    where: {
      ...(hasForcedMovieFilter
        ? { id: { in: forceMovieIds } }
        : { id: { notIn: Array.from(excludedMovieIds) } }),
      OR: [
        { plexAvailability: { available: true } },
        { radarrSync: { available: true } },
      ],
    },
    include: {
      genres: { select: { genreId: true } },
      studios: { select: { studioId: true } },
      cast: {
        select: { personId: true },
        orderBy: { castOrder: "asc" },
        take: 5,
      },
      crew: {
        where: { job: "Director" },
        select: { personId: true },
        take: 3,
      },
      ratings: {
        where: { userId: { in: participantIds } },
        select: {
          userId: true,
          rating: true,
          notHeardOf: true,
          hasSeen: true,
        },
      },
      plexAvailability: true,
      radarrSync: true,
    },
    take: hasForcedMovieFilter ? Math.max(forceMovieIds.length, 1) : 500,
  });

  const candidateMovieIds = movies.map((movie) => movie.id);
  const mfPredictionsByUser = new Map<string, Map<string, number>>();
  await Promise.all(
    participantIds.map(async (participantId) => {
      try {
        const predictions = await getPredictedRatingsForUser(
          participantId,
          candidateMovieIds
        );
        mfPredictionsByUser.set(participantId, predictions);
      } catch {
        mfPredictionsByUser.set(participantId, new Map());
      }
    })
  );

  const scored: ScoredMovie[] = movies.map((movie) => {
    const genreSignal = (() => {
      if (movie.genres.length === 0) return 0;

      const values = movie.genres.map(({ genreId }) => {
        const tonight = tonightGenreScores.get(genreId);
        const background = profile.genreAffinity.get(genreId);
        const tonightNormalized = tonight ?? 0.5;
        const backgroundNormalized = background === undefined ? 0.5 : (background + 1) / 2;
        const combined = tonightNormalized * 0.7 + backgroundNormalized * 0.3;
        return combined * 2 - 1;
      });

      return values.reduce((sum, value) => sum + value, 0) / values.length;
    })();

    const actorSignal = averageAffinityForIds(
      movie.cast.map((castMember) => castMember.personId),
      profile.actorAffinity
    );

    const directorSignal = averageAffinityForIds(
      movie.crew.map((crewMember) => crewMember.personId),
      profile.directorAffinity
    );

    const studioSignal = averageAffinityForIds(
      movie.studios.map((studio) => studio.studioId),
      profile.studioAffinity
    );

    const movieHistorySignal = profile.movieAffinity.get(movie.id) ?? 0;

    const participantMovieRatings = movie.ratings
      .filter((rating) => !rating.notHeardOf && rating.rating !== null)
      .map((rating) => normalizeRating(rating.rating as number));
    const explicitRatingCoverage =
      participantIds.length > 0
        ? participantMovieRatings.length / participantIds.length
        : 0;

    const participantRatingSignal =
      participantMovieRatings.length > 0
        ? participantMovieRatings.reduce((sum, value) => sum + value, 0) /
            participantMovieRatings.length *
            0.7 +
          Math.min(...participantMovieRatings) * 0.3
        : 0;

    const activeUserHistoricalRating = options.activeUserId
      ? movie.ratings.find(
          (rating) =>
            rating.userId === options.activeUserId &&
            !rating.notHeardOf &&
            typeof rating.rating === "number"
        )
      : undefined;
    const activeUserHistorySignal = activeUserHistoricalRating?.rating
      ? normalizeRating(activeUserHistoricalRating.rating)
      : 0;
    const explicitHistorySignal =
      participantRatingSignal * 0.7 + activeUserHistorySignal * 0.3;
    const explicitEvidenceStrength = clamp(
      explicitRatingCoverage * 0.8 + (activeUserHistoricalRating ? 0.2 : 0),
      0,
      1
    );

    const mfParticipantPredictions = participantIds
      .map((participantId) =>
        mfPredictionsByUser.get(participantId)?.get(movie.id)
      )
      .filter(
        (prediction): prediction is number =>
          typeof prediction === "number" && Number.isFinite(prediction)
      );

    const mfSharedSignal =
      mfParticipantPredictions.length > 0
        ? normalizeFiveStarSignal(
            mfParticipantPredictions.reduce((sum, value) => sum + value, 0) /
              mfParticipantPredictions.length *
              0.7 +
              Math.min(...mfParticipantPredictions) * 0.3
          )
        : 0;

    const mfActiveSignal =
      options.activeUserId && mfPredictionsByUser.has(options.activeUserId)
        ? normalizeFiveStarSignal(
            mfPredictionsByUser.get(options.activeUserId)?.get(movie.id)
          )
        : 0;

    const mfSignal =
      options.activeUserId && options.activeUserId.length > 0
        ? mfSharedSignal * 0.7 + mfActiveSignal * 0.3
        : mfSharedSignal;

    const releaseYearSignal = (() => {
      if (participantsWithYearRange.length === 0) return 0;
      if (!movie.year) return -0.1;

      const scores = participantsWithYearRange.map((participant) => {
        const rangeMin = Math.min(
          participant.minReleaseYear as number,
          participant.maxReleaseYear as number
        );
        const rangeMax = Math.max(
          participant.minReleaseYear as number,
          participant.maxReleaseYear as number
        );

        if (movie.year! >= rangeMin && movie.year! <= rangeMax) {
          return 1;
        }

        const distance =
          movie.year! < rangeMin
            ? rangeMin - movie.year!
            : movie.year! - rangeMax;

        return -clamp(distance / 25, 0, 1);
      });

      return scores.reduce((sum, value) => sum + value, 0) / scores.length;
    })();

    const seenCount = movie.ratings.filter((rating) => rating.hasSeen).length;
    const mixedSeenPenalty =
      seenCount > 0 && seenCount < participantIds.length
        ? tuning.mixedSeenPenalty
        : 0;

    // Heavy penalty if any participant who doesn't want rewatches has seen this movie
    const noRewatchSeenPenalty = movie.ratings.some(
      (rating) => rating.hasSeen && noRewatchParticipantIds.has(rating.userId)
    )
      ? -2.0 // Strong penalty to effectively exclude these movies
      : 0;
    const activeUserNoRewatchPenalty =
      options.activeUserId &&
      participantById.get(options.activeUserId)?.okWithRewatch === false &&
      movie.ratings.some(
        (rating) => rating.userId === options.activeUserId && rating.hasSeen
      )
        ? -2.2
        : 0;

    const movieSessionVotes = sessionVotesByMovie.get(movie.id) ?? [];
    const movieSessionVotesFromOthers = options.activeUserId
      ? movieSessionVotes.filter((vote) => vote.userId !== options.activeUserId)
      : movieSessionVotes;
    const alreadyVotedByActiveUser =
      options.activeUserId !== undefined
        ? movieSessionVotes.some((vote) => vote.userId === options.activeUserId)
        : false;

    const sessionMomentumSignal =
      movieSessionVotesFromOthers.length > 0
        ? normalizeFiveStarSignal(
            movieSessionVotesFromOthers.reduce(
              (sum, vote) => sum + vote.rating,
              0
            ) / movieSessionVotesFromOthers.length
          )
        : 0;
    const sessionCoverageSignal =
      participantIds.length > 1
        ? clamp(
            movieSessionVotesFromOthers.length /
              (participantIds.length - (options.activeUserId ? 1 : 0)),
            0,
            1
          )
        : 0;
    const sessionBoostForUnrated =
      !alreadyVotedByActiveUser && movieSessionVotesFromOthers.length > 0
        ? sessionMomentumSignal * (0.55 + 0.45 * sessionCoverageSignal)
        : 0;

    const availabilityBonus =
      (movie.radarrSync?.available ? tuning.radarrAvailableBoost : 0) +
      (movie.radarrSync?.monitored ? tuning.radarrMonitoredBoost : 0) +
      (movie.plexAvailability?.available ? tuning.plexAvailableBoost : 0);

    const preferenceSignal =
      genreSignal * 0.25 +
      actorSignal * 0.16 +
      directorSignal * 0.1 +
      studioSignal * 0.12 +
      movieHistorySignal * 0.14 +
      releaseYearSignal * 0.23 +
      mixedSeenPenalty;

    const knownByParticipantsRatio =
      movie.ratings.length > 0 ? movie.ratings.length / participantIds.length : 0;
    const noveltySignal = 1 - knownByParticipantsRatio;

    const qualitySignal =
      clamp((movie.voteAverage ?? 0) / 10, 0, 1) * 0.6 +
      clamp((movie.popularity ?? 0) / 100, 0, 1) * 0.4;

    const discoverySignal = (noveltySignal * 0.6 + qualitySignal * 0.4) * 2 - 1;

    const randomJitterMagnitude = options.activeUserId
      ? 0
      : tuning.randomJitterBase +
        profile.avgExplorationFactor * tuning.randomJitterExploration;
    const exploitationFactor = 1 - profile.avgExplorationFactor;
    const mfWeight = 0.5 * (0.35 + (1 - explicitEvidenceStrength) * 0.65);
    const explicitHistoryWeight = 0.15 + explicitEvidenceStrength * 0.45;

    const score =
      mfSignal * mfWeight +
      explicitHistorySignal * explicitHistoryWeight +
      preferenceSignal *
        tuning.preferenceWeight *
        (0.55 + exploitationFactor * 0.45) *
        0.75 +
      discoverySignal *
        tuning.discoveryWeight *
        profile.avgExplorationFactor *
        0.35 +
      sessionBoostForUnrated * 0.7 +
      availabilityBonus +
      noRewatchSeenPenalty +
      activeUserNoRewatchPenalty +
      deterministicJitter(
        `${sessionId}:${movie.id}:${participantIds.length}`,
        randomJitterMagnitude
      );

    return {
      movieId: movie.id,
      title: movie.title,
      score,
      posterUrl: movie.posterUrl,
      year: movie.year,
      era: movie.era,
      available:
        movie.plexAvailability?.available || movie.radarrSync?.available || false,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, count);
}

export async function decideMovie(sessionId: string) {
  const sessionMovies = await prisma.sessionMovie.findMany({
    where: { sessionId },
    include: {
      votes: true,
      movie: true,
    },
  });

  if (sessionMovies.length === 0) return null;

  const moviesWithVotes = sessionMovies.filter((sm) => sm.votes.length > 0);
  if (moviesWithVotes.length === 0) return null;

  const movieScores = moviesWithVotes.map((sm) => {
    const votes = sm.votes;
    const avgRating = votes.reduce((sum, v) => sum + v.rating, 0) / votes.length;
    const minRating = Math.min(...votes.map((v) => v.rating));

    const score = avgRating * 0.6 + minRating * 0.4;

    return { movie: sm.movie, score, minRating };
  });

  movieScores.sort((a, b) => b.score - a.score);
  const winner = movieScores[0];

  if (winner) {
    await prisma.movieNightSession.update({
      where: { id: sessionId },
      data: {
        decidedMovieId: winner.movie.id,
        status: "decided",
      },
    });
  }

  return winner;
}

export async function checkAndSyncToRadarr() {
  const highRatedMovies = await prisma.movie.findMany({
    where: {
      tmdbId: { not: null },
      radarrSync: null,
      ratings: {
        some: {
          rating: { gte: 4 },
          hasSeen: false,
        },
      },
    },
    include: {
      ratings: {
        where: { rating: { gte: 4 }, hasSeen: false },
      },
    },
  });

  return highRatedMovies.filter((movie) => movie.ratings.length >= 2);
}
