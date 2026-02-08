import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const SUPPORTED_VERSIONS = [1];

interface BackupData {
  version: number;
  createdAt: string;
  users: {
    id: string;
    email: string | null;
    name: string;
    passwordHash: string | null;
    avatarUrl: string | null;
    isGuest: boolean;
  }[];
  households: {
    id: string;
    name: string;
    inviteCode: string;
  }[];
  householdMembers: {
    userId: string;
    householdId: string;
    role: string;
  }[];
  genres: {
    id: string;
    name: string;
    slug: string;
  }[];
  studios: {
    id: string;
    name: string;
    slug: string;
  }[];
  people: {
    id: string;
    tmdbId: string | null;
    name: string;
    photoUrl: string | null;
    knownFor: string | null;
  }[];
  movies: {
    id: string;
    imdbId: string | null;
    tmdbId: string | null;
    traktSlug: string | null;
    title: string;
    year: number | null;
    posterUrl: string | null;
    overview: string | null;
    runtime: number | null;
    era: string | null;
    imdbRating: number | null;
    rottenTomatoesAudience: number | null;
  }[];
  movieGenres: {
    movieId: string;
    genreId: string;
  }[];
  movieStudios: {
    movieId: string;
    studioId: string;
  }[];
  movieCast: {
    movieId: string;
    personId: string;
    character: string | null;
    castOrder: number | null;
  }[];
  movieCrew: {
    movieId: string;
    personId: string;
    job: string;
  }[];
  genreRankings: {
    userId: string;
    genreId: string;
    rank: number;
  }[];
  movieRatings: {
    userId: string;
    movieId: string;
    rating: number | null;
    hasSeen: boolean;
    notHeardOf: boolean;
  }[];
  actorRatings: {
    userId: string;
    personId: string;
    rating: number | null;
    notHeardOf: boolean;
  }[];
  directorRatings: {
    userId: string;
    personId: string;
    rating: number | null;
    notHeardOf: boolean;
  }[];
  studioRatings: {
    userId: string;
    studioId: string;
    rating: number | null;
    notHeardOf: boolean;
  }[];
  userSettings: {
    userId: string;
    explorationFactor: number;
    discoverySourcePref: string;
  }[];
  integrationConfigs: {
    service: string;
    baseUrl: string | null;
    apiKey: string | null;
    enabled: boolean;
  }[];
  // ML Model data
  latentVectors?: {
    entityType: string;
    entityId: string;
    vector: string;
    bias: number;
  }[];
  featureEmbeddings?: {
    featureType: string;
    featureId: string;
    vector: string;
    bias: number;
  }[];
  mfModelMetadata?: {
    version: number;
    latentDimensions: number;
    featureDimensions: number;
    learningRate: number;
    regularization: number;
    trainedEpochs: number;
    lastTrainedAt: string | null;
    rmse: number | null;
    validationRmse: number | null;
    totalRatings: number;
    isTraining: boolean;
    globalMean: number;
    featureWeights: string | null;
  } | null;
  userFeatureCaches?: {
    userId: string;
    explorationFactor: number;
    genreVector: string | null;
    ratingMean: number | null;
    ratingStdDev: number | null;
    ratingCount: number;
    topGenreIds: string | null;
  }[];
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let backup: BackupData;
  try {
    backup = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!backup.version || !SUPPORTED_VERSIONS.includes(backup.version)) {
    return NextResponse.json(
      { error: `Unsupported backup version. Supported: ${SUPPORTED_VERSIONS.join(", ")}` },
      { status: 400 }
    );
  }

  const stats = {
    genres: 0,
    studios: 0,
    people: 0,
    movies: 0,
    movieGenres: 0,
    movieStudios: 0,
    movieCast: 0,
    movieCrew: 0,
    genreRankings: 0,
    movieRatings: 0,
    actorRatings: 0,
    directorRatings: 0,
    studioRatings: 0,
    userSettings: 0,
    integrationConfigs: 0,
    latentVectors: 0,
    featureEmbeddings: 0,
    mfModelMetadata: 0,
    userFeatureCaches: 0,
    skipped: 0,
  };

  // Import genres
  for (const genre of backup.genres || []) {
    try {
      await prisma.genre.upsert({
        where: { id: genre.id },
        create: { id: genre.id, name: genre.name, slug: genre.slug },
        update: { name: genre.name, slug: genre.slug },
      });
      stats.genres++;
    } catch {
      stats.skipped++;
    }
  }

  // Import studios
  for (const studio of backup.studios || []) {
    try {
      await prisma.studio.upsert({
        where: { id: studio.id },
        create: { id: studio.id, name: studio.name, slug: studio.slug },
        update: { name: studio.name, slug: studio.slug },
      });
      stats.studios++;
    } catch {
      stats.skipped++;
    }
  }

  // Import people
  for (const person of backup.people || []) {
    try {
      await prisma.person.upsert({
        where: { id: person.id },
        create: {
          id: person.id,
          tmdbId: person.tmdbId,
          name: person.name,
          photoUrl: person.photoUrl,
          knownFor: person.knownFor,
        },
        update: {
          tmdbId: person.tmdbId,
          name: person.name,
          photoUrl: person.photoUrl,
          knownFor: person.knownFor,
        },
      });
      stats.people++;
    } catch {
      stats.skipped++;
    }
  }

  // Import movies
  for (const movie of backup.movies || []) {
    try {
      await prisma.movie.upsert({
        where: { id: movie.id },
        create: {
          id: movie.id,
          imdbId: movie.imdbId,
          tmdbId: movie.tmdbId,
          traktSlug: movie.traktSlug,
          title: movie.title,
          year: movie.year,
          posterUrl: movie.posterUrl,
          overview: movie.overview,
          runtime: movie.runtime,
          era: movie.era,
          imdbRating: movie.imdbRating,
          rottenTomatoesAudience: movie.rottenTomatoesAudience,
        },
        update: {
          imdbId: movie.imdbId,
          tmdbId: movie.tmdbId,
          traktSlug: movie.traktSlug,
          title: movie.title,
          year: movie.year,
          posterUrl: movie.posterUrl,
          overview: movie.overview,
          runtime: movie.runtime,
          era: movie.era,
          imdbRating: movie.imdbRating,
          rottenTomatoesAudience: movie.rottenTomatoesAudience,
        },
      });
      stats.movies++;
    } catch {
      stats.skipped++;
    }
  }

  // Import movie-genre relations
  for (const mg of backup.movieGenres || []) {
    try {
      await prisma.movieGenre.upsert({
        where: { movieId_genreId: { movieId: mg.movieId, genreId: mg.genreId } },
        create: { movieId: mg.movieId, genreId: mg.genreId },
        update: {},
      });
      stats.movieGenres++;
    } catch {
      stats.skipped++;
    }
  }

  // Import movie-studio relations
  for (const ms of backup.movieStudios || []) {
    try {
      await prisma.movieStudio.upsert({
        where: { movieId_studioId: { movieId: ms.movieId, studioId: ms.studioId } },
        create: { movieId: ms.movieId, studioId: ms.studioId },
        update: {},
      });
      stats.movieStudios++;
    } catch {
      stats.skipped++;
    }
  }

  // Import movie cast
  for (const mc of backup.movieCast || []) {
    try {
      await prisma.movieCast.upsert({
        where: { movieId_personId: { movieId: mc.movieId, personId: mc.personId } },
        create: {
          movieId: mc.movieId,
          personId: mc.personId,
          character: mc.character,
          castOrder: mc.castOrder,
        },
        update: { character: mc.character, castOrder: mc.castOrder },
      });
      stats.movieCast++;
    } catch {
      stats.skipped++;
    }
  }

  // Import movie crew
  for (const mc of backup.movieCrew || []) {
    try {
      await prisma.movieCrew.upsert({
        where: {
          movieId_personId_job: {
            movieId: mc.movieId,
            personId: mc.personId,
            job: mc.job,
          },
        },
        create: { movieId: mc.movieId, personId: mc.personId, job: mc.job },
        update: {},
      });
      stats.movieCrew++;
    } catch {
      stats.skipped++;
    }
  }

  // Import user-specific data - match by email if user exists
  const userIdMap = new Map<string, string>();
  for (const backupUser of backup.users || []) {
    if (!backupUser.email) continue;
    const existingUser = await prisma.user.findUnique({
      where: { email: backupUser.email },
      select: { id: true },
    });
    if (existingUser) {
      userIdMap.set(backupUser.id, existingUser.id);
    }
  }

  // Import genre rankings for matched users
  for (const gr of backup.genreRankings || []) {
    const mappedUserId = userIdMap.get(gr.userId);
    if (!mappedUserId) continue;
    try {
      await prisma.genreRanking.upsert({
        where: { userId_genreId: { userId: mappedUserId, genreId: gr.genreId } },
        create: { userId: mappedUserId, genreId: gr.genreId, rank: gr.rank },
        update: { rank: gr.rank },
      });
      stats.genreRankings++;
    } catch {
      stats.skipped++;
    }
  }

  // Import movie ratings for matched users
  for (const mr of backup.movieRatings || []) {
    const mappedUserId = userIdMap.get(mr.userId);
    if (!mappedUserId) continue;
    try {
      await prisma.movieRating.upsert({
        where: { userId_movieId: { userId: mappedUserId, movieId: mr.movieId } },
        create: {
          userId: mappedUserId,
          movieId: mr.movieId,
          rating: mr.rating,
          hasSeen: mr.hasSeen,
          notHeardOf: mr.notHeardOf,
        },
        update: {
          rating: mr.rating,
          hasSeen: mr.hasSeen,
          notHeardOf: mr.notHeardOf,
        },
      });
      stats.movieRatings++;
    } catch {
      stats.skipped++;
    }
  }

  // Import actor ratings for matched users
  for (const ar of backup.actorRatings || []) {
    const mappedUserId = userIdMap.get(ar.userId);
    if (!mappedUserId) continue;
    try {
      await prisma.actorRating.upsert({
        where: { userId_personId: { userId: mappedUserId, personId: ar.personId } },
        create: {
          userId: mappedUserId,
          personId: ar.personId,
          rating: ar.rating,
          notHeardOf: ar.notHeardOf,
        },
        update: { rating: ar.rating, notHeardOf: ar.notHeardOf },
      });
      stats.actorRatings++;
    } catch {
      stats.skipped++;
    }
  }

  // Import director ratings for matched users
  for (const dr of backup.directorRatings || []) {
    const mappedUserId = userIdMap.get(dr.userId);
    if (!mappedUserId) continue;
    try {
      await prisma.directorRating.upsert({
        where: { userId_personId: { userId: mappedUserId, personId: dr.personId } },
        create: {
          userId: mappedUserId,
          personId: dr.personId,
          rating: dr.rating,
          notHeardOf: dr.notHeardOf,
        },
        update: { rating: dr.rating, notHeardOf: dr.notHeardOf },
      });
      stats.directorRatings++;
    } catch {
      stats.skipped++;
    }
  }

  // Import studio ratings for matched users
  for (const sr of backup.studioRatings || []) {
    const mappedUserId = userIdMap.get(sr.userId);
    if (!mappedUserId) continue;
    try {
      await prisma.studioRating.upsert({
        where: { userId_studioId: { userId: mappedUserId, studioId: sr.studioId } },
        create: {
          userId: mappedUserId,
          studioId: sr.studioId,
          rating: sr.rating,
          notHeardOf: sr.notHeardOf,
        },
        update: { rating: sr.rating, notHeardOf: sr.notHeardOf },
      });
      stats.studioRatings++;
    } catch {
      stats.skipped++;
    }
  }

  // Import user settings for matched users
  for (const us of backup.userSettings || []) {
    const mappedUserId = userIdMap.get(us.userId);
    if (!mappedUserId) continue;
    try {
      await prisma.userSettings.upsert({
        where: { userId: mappedUserId },
        create: {
          userId: mappedUserId,
          explorationFactor: us.explorationFactor,
          discoverySourcePref: us.discoverySourcePref,
        },
        update: {
          explorationFactor: us.explorationFactor,
          discoverySourcePref: us.discoverySourcePref,
        },
      });
      stats.userSettings++;
    } catch {
      stats.skipped++;
    }
  }

  // Import integration configs (including API keys if present)
  for (const ic of backup.integrationConfigs || []) {
    try {
      await prisma.integrationConfig.upsert({
        where: { service: ic.service },
        create: {
          service: ic.service,
          baseUrl: ic.baseUrl,
          apiKey: ic.apiKey,
          enabled: ic.enabled,
        },
        update: {
          baseUrl: ic.baseUrl,
          apiKey: ic.apiKey,
          enabled: ic.enabled,
        },
      });
      stats.integrationConfigs++;
    } catch {
      stats.skipped++;
    }
  }

  // Import ML model data - latent vectors
  // First clear existing ML data to avoid conflicts
  if (backup.latentVectors && backup.latentVectors.length > 0) {
    await prisma.latentVector.deleteMany({});
    for (const lv of backup.latentVectors) {
      try {
        await prisma.latentVector.create({
          data: {
            entityType: lv.entityType,
            entityId: lv.entityId,
            vector: lv.vector,
            bias: lv.bias,
          },
        });
        stats.latentVectors++;
      } catch {
        stats.skipped++;
      }
    }
  }

  // Import feature embeddings
  if (backup.featureEmbeddings && backup.featureEmbeddings.length > 0) {
    await prisma.featureEmbedding.deleteMany({});
    for (const fe of backup.featureEmbeddings) {
      try {
        await prisma.featureEmbedding.create({
          data: {
            featureType: fe.featureType,
            featureId: fe.featureId,
            vector: fe.vector,
            bias: fe.bias,
          },
        });
        stats.featureEmbeddings++;
      } catch {
        stats.skipped++;
      }
    }
  }

  // Import MF model metadata
  if (backup.mfModelMetadata) {
    try {
      await prisma.mFModelMetadata.deleteMany({});
      await prisma.mFModelMetadata.create({
        data: {
          version: backup.mfModelMetadata.version,
          latentDimensions: backup.mfModelMetadata.latentDimensions,
          featureDimensions: backup.mfModelMetadata.featureDimensions,
          learningRate: backup.mfModelMetadata.learningRate,
          regularization: backup.mfModelMetadata.regularization,
          trainedEpochs: backup.mfModelMetadata.trainedEpochs,
          lastTrainedAt: backup.mfModelMetadata.lastTrainedAt
            ? new Date(backup.mfModelMetadata.lastTrainedAt)
            : null,
          rmse: backup.mfModelMetadata.rmse,
          validationRmse: backup.mfModelMetadata.validationRmse,
          totalRatings: backup.mfModelMetadata.totalRatings,
          isTraining: false, // Reset training state
          globalMean: backup.mfModelMetadata.globalMean,
          featureWeights: backup.mfModelMetadata.featureWeights,
        },
      });
      stats.mfModelMetadata++;
    } catch {
      stats.skipped++;
    }
  }

  // Import user feature caches
  if (backup.userFeatureCaches && backup.userFeatureCaches.length > 0) {
    for (const ufc of backup.userFeatureCaches) {
      const mappedUserId = userIdMap.get(ufc.userId);
      if (!mappedUserId) continue;
      try {
        await prisma.userFeatureCache.upsert({
          where: { userId: mappedUserId },
          create: {
            userId: mappedUserId,
            explorationFactor: ufc.explorationFactor,
            genreVector: ufc.genreVector,
            ratingMean: ufc.ratingMean,
            ratingStdDev: ufc.ratingStdDev,
            ratingCount: ufc.ratingCount,
            topGenreIds: ufc.topGenreIds,
          },
          update: {
            explorationFactor: ufc.explorationFactor,
            genreVector: ufc.genreVector,
            ratingMean: ufc.ratingMean,
            ratingStdDev: ufc.ratingStdDev,
            ratingCount: ufc.ratingCount,
            topGenreIds: ufc.topGenreIds,
          },
        });
        stats.userFeatureCaches++;
      } catch {
        stats.skipped++;
      }
    }
  }

  return NextResponse.json({
    message: "Backup restored successfully",
    backupDate: backup.createdAt,
    usersMatched: userIdMap.size,
    stats,
  });
}
