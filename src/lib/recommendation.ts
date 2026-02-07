import { prisma } from "./prisma";
import {
  averageAffinityForIds,
  buildGroupPreferenceProfile,
} from "./preference-profile";
import { getAlgorithmSettings } from "./algorithm-settings";

interface ScoredMovie {
  movieId: string;
  title: string;
  score: number;
  posterUrl: string | null;
  year: number | null;
  era: string | null;
  available: boolean;
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

export async function getRecommendationsForSession(
  sessionId: string,
  count = 10
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

  // Track participants who don't want to rewatch movies
  const noRewatchParticipantIds = new Set(
    session.participants
      .filter((participant) => participant.okWithRewatch === false)
      .map((participant) => participant.userId)
  );

  const existingSessionMovies = await prisma.sessionMovie.findMany({
    where: { sessionId },
    select: { movieId: true },
  });
  const excludedMovieIds = existingSessionMovies.map((movie) => movie.movieId);

  // Only show movies that are available on Plex or Radarr (with file)
  const movies = await prisma.movie.findMany({
    where: {
      id: { notIn: excludedMovieIds },
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
    take: 400,
  });

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

    const participantRatingSignal =
      participantMovieRatings.length > 0
        ? participantMovieRatings.reduce((sum, value) => sum + value, 0) /
            participantMovieRatings.length *
            0.7 +
          Math.min(...participantMovieRatings) * 0.3
        : 0;

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

    const availabilityBonus =
      (movie.radarrSync?.available ? tuning.radarrAvailableBoost : 0) +
      (movie.radarrSync?.monitored ? tuning.radarrMonitoredBoost : 0) +
      (movie.plexAvailability?.available ? tuning.plexAvailableBoost : 0);

    const preferenceSignal =
      genreSignal * 0.28 +
      actorSignal * 0.16 +
      directorSignal * 0.1 +
      studioSignal * 0.12 +
      movieHistorySignal * 0.14 +
      participantRatingSignal * 0.14 +
      releaseYearSignal * 0.16 +
      mixedSeenPenalty;

    const knownByParticipantsRatio =
      movie.ratings.length > 0 ? movie.ratings.length / participantIds.length : 0;
    const noveltySignal = 1 - knownByParticipantsRatio;

    const qualitySignal =
      clamp((movie.voteAverage ?? 0) / 10, 0, 1) * 0.6 +
      clamp((movie.popularity ?? 0) / 100, 0, 1) * 0.4;

    const discoverySignal = (noveltySignal * 0.6 + qualitySignal * 0.4) * 2 - 1;

    const score =
      preferenceSignal *
        tuning.preferenceWeight *
        (1 - profile.avgExplorationFactor) +
      discoverySignal *
        tuning.discoveryWeight *
        profile.avgExplorationFactor +
      availabilityBonus +
      noRewatchSeenPenalty +
      Math.random() *
        (tuning.randomJitterBase +
          profile.avgExplorationFactor * tuning.randomJitterExploration);

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
