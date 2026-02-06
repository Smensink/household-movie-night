import { prisma } from "./prisma";

interface ScoredMovie {
  movieId: string;
  title: string;
  score: number;
  posterUrl: string | null;
  year: number | null;
  era: string | null;
  available: boolean;
}

export async function getRecommendationsForSession(
  sessionId: string,
  count = 10
): Promise<ScoredMovie[]> {
  const session = await prisma.movieNightSession.findUnique({
    where: { id: sessionId },
    include: {
      participants: {
        include: { user: true },
      },
      genrePreferences: true,
    },
  });

  if (!session) return [];

  const participantIds = session.participants.map((p) => p.userId);

  // Get exploration factor for each participant (average them)
  const userSettings = await prisma.userSettings.findMany({
    where: { userId: { in: participantIds } },
  });
  const avgExploration =
    userSettings.length > 0
      ? userSettings.reduce((sum, s) => sum + s.explorationFactor, 0) /
        userSettings.length
      : 0.5;

  // Get era preferences from participants
  const eraPrefs = session.participants
    .map((p) => p.eraPreference)
    .filter(Boolean);

  // Get genre preferences for this session
  const genrePrefs = session.genrePreferences;
  const genreScores = new Map<string, number>();
  for (const pref of genrePrefs) {
    const current = genreScores.get(pref.genreId) || 0;
    genreScores.set(pref.genreId, current + (10 - pref.rank));
  }

  // Get background genre rankings
  const bgGenreRankings = await prisma.genreRanking.findMany({
    where: { userId: { in: participantIds } },
  });
  for (const ranking of bgGenreRankings) {
    const current = genreScores.get(ranking.genreId) || 0;
    // Weight background preferences inversely with exploration factor
    const bgWeight = 0.5 * (1 - avgExploration);
    genreScores.set(ranking.genreId, current + (20 - ranking.rank) * bgWeight);
  }

  // Get studio ratings for participants
  const studioRatings = await prisma.studioRating.findMany({
    where: { userId: { in: participantIds }, notHeardOf: false },
  });
  const studioScores = new Map<string, { total: number; count: number }>();
  for (const sr of studioRatings) {
    if (sr.rating === null) continue;
    const existing = studioScores.get(sr.studioId) || { total: 0, count: 0 };
    existing.total += sr.rating;
    existing.count += 1;
    studioScores.set(sr.studioId, existing);
  }

  // Get already-voted movies to exclude
  const existingSessionMovies = await prisma.sessionMovie.findMany({
    where: { sessionId },
    select: { movieId: true },
  });
  const excludeIds = new Set(existingSessionMovies.map((m) => m.movieId));

  // Get candidate movies with their genres, studios, ratings, and availability
  const movies = await prisma.movie.findMany({
    where: {
      id: { notIn: Array.from(excludeIds) },
      ...(eraPrefs.length > 0 ? { era: { in: eraPrefs as string[] } } : {}),
    },
    include: {
      genres: { include: { genre: true } },
      studios: { include: { studio: true } },
      ratings: {
        where: { userId: { in: participantIds } },
      },
      plexAvailability: true,
      radarrSync: true,
    },
    take: 200,
  });

  // Score each movie
  const scored: ScoredMovie[] = movies.map((movie) => {
    let score = 0;

    // Genre match score (0-30)
    for (const mg of movie.genres) {
      score += genreScores.get(mg.genreId) || 0;
    }

    // Studio rating boost (0-10)
    for (const ms of movie.studios) {
      const studioData = studioScores.get(ms.studioId);
      if (studioData && studioData.count > 0) {
        const avgStudioRating = studioData.total / studioData.count;
        score += avgStudioRating * (1 - avgExploration);
      }
    }

    // Popularity baseline (0-10) - weighted more with higher exploration
    score += ((movie.popularity || 0) / 10) * (0.5 + avgExploration * 0.5);

    // External rating boost (0-10)
    score += movie.voteAverage || 0;

    // User rating compatibility (0-20) - weighted more with lower exploration
    let ratingScore = 0;
    let ratingCount = 0;
    for (const rating of movie.ratings) {
      if (rating.notHeardOf) continue;
      if (rating.rating !== null) {
        ratingScore += rating.rating;
        ratingCount++;
      }
    }
    if (ratingCount > 0) {
      // Deep dive: high weight on known preferences
      const prefWeight = 4 * (1 - avgExploration) + 1;
      score += (ratingScore / ratingCount) * prefWeight;
    } else {
      // Unknown movie: exploration bonus
      score += avgExploration * 8;
    }

    // Penalize movies someone has already seen (unless all have seen it)
    const seenCount = movie.ratings.filter((r) => r.hasSeen).length;
    if (seenCount > 0 && seenCount < participantIds.length) {
      score *= 0.7;
    }

    // Availability bonus
    const available =
      movie.plexAvailability?.available || movie.radarrSync?.available || false;
    if (available) {
      score += 15;
    }

    // Exploration randomness: more exploration = more randomness
    const randomFactor = 5 + avgExploration * 10;
    score += Math.random() * randomFactor;

    return {
      movieId: movie.id,
      title: movie.title,
      score,
      posterUrl: movie.posterUrl,
      year: movie.year,
      era: movie.era,
      available,
    };
  });

  // Sort by score and return top N
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

    // Weight: high average + high minimum (fairness)
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

  return highRatedMovies.filter((m) => m.ratings.length >= 2);
}
