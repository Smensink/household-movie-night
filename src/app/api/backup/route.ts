import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const BACKUP_VERSION = 2;

// Fetch image and convert to base64
async function fetchImageAsBase64(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'MovieNightApp/1.0' }
    });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    return `data:${contentType};base64,${base64}`;
  } catch {
    return null;
  }
}

// Batch fetch images with concurrency limit
async function fetchImagesInBatches<T extends { url: string | null }>(
  items: T[],
  concurrency: number = 20
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const urls = items.filter(i => i.url).map(i => i.url as string);

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const promises = batch.map(async (url) => {
      const data = await fetchImageAsBase64(url);
      if (data) results.set(url, data);
    });
    await Promise.all(promises);
  }

  return results;
}

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
    photoData: string | null; // base64 encoded image
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
    posterData: string | null; // base64 encoded image
    backdropUrl: string | null;
    backdropData: string | null; // base64 encoded image
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

  // Fetch all images in parallel batches
  console.log(`Fetching ${movies.length} movie posters and ${people.length} person photos...`);

  // Collect all URLs to fetch
  const posterUrls = movies.filter(m => m.posterUrl).map(m => ({ url: m.posterUrl }));
  const backdropUrls = movies.filter(m => m.backdropUrl).map(m => ({ url: m.backdropUrl }));
  const photoUrls = people.filter(p => p.photoUrl).map(p => ({ url: p.photoUrl }));

  // Fetch all images with concurrency limit
  const [posterData, backdropData, photoData] = await Promise.all([
    fetchImagesInBatches(posterUrls, 30),
    fetchImagesInBatches(backdropUrls, 30),
    fetchImagesInBatches(photoUrls, 30),
  ]);

  console.log(`Fetched ${posterData.size} posters, ${backdropData.size} backdrops, ${photoData.size} photos`);

  const backup: BackupData = {
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    users,
    households,
    householdMembers,
    genres,
    studios,
    people: people.map((p) => ({
      ...p,
      photoData: p.photoUrl ? photoData.get(p.photoUrl) || null : null,
    })),
    movies: movies.map((m) => ({
      ...m,
      releaseDate: m.releaseDate?.toISOString() || null,
      posterData: m.posterUrl ? posterData.get(m.posterUrl) || null : null,
      backdropData: m.backdropUrl ? backdropData.get(m.backdropUrl) || null : null,
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
