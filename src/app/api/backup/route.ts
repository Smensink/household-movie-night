import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const BACKUP_VERSION = 1;

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
    backdropUrl: string | null;
    overview: string | null;
    runtime: number | null;
    releaseDate: string | null;
    certification: string | null;
    popularity: number | null;
    voteAverage: number | null;
    voteCount: number | null;
    imdbRating: number | null;
    imdbVotes: number | null;
    rottenTomatoesAudience: number | null;
    letterboxdRating: number | null;
    era: string | null;
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
  latentVectors: {
    entityType: string;
    entityId: string;
    vector: string;
    bias: number;
  }[];
  featureEmbeddings: {
    featureType: string;
    featureId: string;
    vector: string;
    bias: number;
  }[];
  mfModelMetadata: {
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
  userFeatureCaches: {
    userId: string;
    explorationFactor: number;
    genreVector: string | null;
    ratingMean: number | null;
    ratingStdDev: number | null;
    ratingCount: number;
    topGenreIds: string | null;
  }[];
  // Availability data
  radarrSyncs: {
    movieId: string;
    radarrId: number | null;
    monitored: boolean;
    available: boolean;
  }[];
  plexAvailabilities: {
    movieId: string;
    plexKey: string | null;
    available: boolean;
  }[];
  // Activity log for ML training
  activityLogs: {
    userId: string | null;
    action: string;
    entityType: string | null;
    entityId: string | null;
    createdAt: string;
  }[];
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Fetch all data in parallel
  const [
    users,
    households,
    householdMembers,
    genres,
    studios,
    people,
    movies,
    movieGenres,
    movieStudios,
    movieCast,
    movieCrew,
    genreRankings,
    movieRatings,
    actorRatings,
    directorRatings,
    studioRatings,
    userSettings,
    integrationConfigs,
    latentVectors,
    featureEmbeddings,
    mfModelMetadata,
    userFeatureCaches,
    radarrSyncs,
    plexAvailabilities,
    activityLogs,
  ] = await Promise.all([
    prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        passwordHash: true,
        avatarUrl: true,
        isGuest: true,
      },
    }),
    prisma.household.findMany({
      select: { id: true, name: true, inviteCode: true },
    }),
    prisma.householdMember.findMany({
      select: { userId: true, householdId: true, role: true },
    }),
    prisma.genre.findMany({
      select: { id: true, name: true, slug: true },
    }),
    prisma.studio.findMany({
      select: { id: true, name: true, slug: true },
    }),
    prisma.person.findMany({
      select: { id: true, tmdbId: true, name: true, photoUrl: true, knownFor: true },
    }),
    prisma.movie.findMany({
      select: {
        id: true,
        imdbId: true,
        tmdbId: true,
        traktSlug: true,
        title: true,
        year: true,
        posterUrl: true,
        backdropUrl: true,
        overview: true,
        runtime: true,
        releaseDate: true,
        certification: true,
        popularity: true,
        voteAverage: true,
        voteCount: true,
        imdbRating: true,
        imdbVotes: true,
        rottenTomatoesAudience: true,
        letterboxdRating: true,
        era: true,
      },
    }),
    prisma.movieGenre.findMany({
      select: { movieId: true, genreId: true },
    }),
    prisma.movieStudio.findMany({
      select: { movieId: true, studioId: true },
    }),
    prisma.movieCast.findMany({
      select: { movieId: true, personId: true, character: true, castOrder: true },
    }),
    prisma.movieCrew.findMany({
      select: { movieId: true, personId: true, job: true },
    }),
    prisma.genreRanking.findMany({
      select: { userId: true, genreId: true, rank: true },
    }),
    prisma.movieRating.findMany({
      select: {
        userId: true,
        movieId: true,
        rating: true,
        hasSeen: true,
        notHeardOf: true,
      },
    }),
    prisma.actorRating.findMany({
      select: { userId: true, personId: true, rating: true, notHeardOf: true },
    }),
    prisma.directorRating.findMany({
      select: { userId: true, personId: true, rating: true, notHeardOf: true },
    }),
    prisma.studioRating.findMany({
      select: { userId: true, studioId: true, rating: true, notHeardOf: true },
    }),
    prisma.userSettings.findMany({
      select: { userId: true, explorationFactor: true, discoverySourcePref: true },
    }),
    prisma.integrationConfig.findMany({
      select: { service: true, baseUrl: true, apiKey: true, enabled: true },
    }),
    // ML Model data
    prisma.latentVector.findMany({
      select: { entityType: true, entityId: true, vector: true, bias: true },
    }),
    prisma.featureEmbedding.findMany({
      select: { featureType: true, featureId: true, vector: true, bias: true },
    }),
    prisma.mFModelMetadata.findFirst({
      select: {
        version: true,
        latentDimensions: true,
        featureDimensions: true,
        learningRate: true,
        regularization: true,
        trainedEpochs: true,
        lastTrainedAt: true,
        rmse: true,
        validationRmse: true,
        totalRatings: true,
        isTraining: true,
        globalMean: true,
        featureWeights: true,
      },
    }),
    prisma.userFeatureCache.findMany({
      select: {
        userId: true,
        explorationFactor: true,
        genreVector: true,
        ratingMean: true,
        ratingStdDev: true,
        ratingCount: true,
        topGenreIds: true,
      },
    }),
    // Availability data
    prisma.radarrSync.findMany({
      select: {
        movieId: true,
        radarrId: true,
        monitored: true,
        available: true,
      },
    }),
    prisma.plexAvailability.findMany({
      select: {
        movieId: true,
        plexKey: true,
        available: true,
      },
    }),
    // Activity log
    prisma.activityLog.findMany({
      select: {
        userId: true,
        action: true,
        entityType: true,
        entityId: true,
        createdAt: true,
      },
    }),
  ]);

  const backup: BackupData = {
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    users,
    households,
    householdMembers,
    genres,
    studios,
    people,
    movies: movies.map((m) => ({
      ...m,
      releaseDate: m.releaseDate?.toISOString() || null,
    })),
    movieGenres,
    movieStudios,
    movieCast,
    movieCrew,
    genreRankings,
    movieRatings,
    actorRatings,
    directorRatings,
    studioRatings,
    userSettings,
    integrationConfigs,
    latentVectors,
    featureEmbeddings,
    mfModelMetadata: mfModelMetadata
      ? {
          ...mfModelMetadata,
          lastTrainedAt: mfModelMetadata.lastTrainedAt?.toISOString() || null,
        }
      : null,
    userFeatureCaches,
    radarrSyncs,
    plexAvailabilities,
    activityLogs: activityLogs.map((a) => ({
      ...a,
      createdAt: a.createdAt.toISOString(),
    })),
  };

  return new NextResponse(JSON.stringify(backup, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="movie-night-backup-${new Date().toISOString().split("T")[0]}.json"`,
    },
  });
}
