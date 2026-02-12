import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isUserHouseholdAdmin } from "@/lib/household-admin";

const BACKUP_VERSION = 2;

// Global backup progress state
let backupProgress = {
  inProgress: false,
  phase: "",
  current: 0,
  total: 0,
  startedAt: null as Date | null,
};

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

// Batch fetch images with concurrency limit and progress tracking
async function fetchImagesInBatches(
  urls: string[],
  concurrency: number,
  phase: string,
  onProgress: (current: number, total: number) => void
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  let completed = 0;

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const promises = batch.map(async (url) => {
      const data = await fetchImageAsBase64(url);
      if (data) results.set(url, data);
      completed++;
      onProgress(completed, urls.length);
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
    photoData: string | null;
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
    posterData: string | null;
    backdropUrl: string | null;
    backdropData: string | null;
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
  activityLogs: {
    userId: string | null;
    action: string;
    entityType: string | null;
    entityId: string | null;
    createdAt: string;
  }[];
}

// GET with ?status=true returns progress, otherwise generates backup
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isAdmin = await isUserHouseholdAdmin(session.user.id);
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }

  // Check if status query param is present
  const status = req.nextUrl.searchParams.get("status");
  if (status === "true") {
    return NextResponse.json({
      ...backupProgress,
      startedAt: backupProgress.startedAt?.toISOString() || null,
    });
  }

  // Check if backup is already in progress
  if (backupProgress.inProgress) {
    return NextResponse.json({
      error: "Backup already in progress",
      progress: backupProgress,
    }, { status: 409 });
  }

  // Start backup
  backupProgress = {
    inProgress: true,
    phase: "Loading database...",
    current: 0,
    total: 0,
    startedAt: new Date(),
  };

  try {
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

    // Collect all URLs to fetch
    const posterUrls = movies.filter(m => m.posterUrl).map(m => m.posterUrl as string);
    const backdropUrls = movies.filter(m => m.backdropUrl).map(m => m.backdropUrl as string);
    const photoUrls = people.filter(p => p.photoUrl).map(p => p.photoUrl as string);

    const totalImages = posterUrls.length + backdropUrls.length + photoUrls.length;
    console.log(`[Backup] Fetching ${totalImages} images (${posterUrls.length} posters, ${backdropUrls.length} backdrops, ${photoUrls.length} photos)`);

    // Fetch posters
    backupProgress.phase = "Fetching movie posters...";
    backupProgress.current = 0;
    backupProgress.total = posterUrls.length;
    const posterData = await fetchImagesInBatches(posterUrls, 30, "posters", (current, total) => {
      backupProgress.current = current;
      backupProgress.total = total;
    });
    console.log(`[Backup] Fetched ${posterData.size}/${posterUrls.length} posters`);

    // Fetch backdrops
    backupProgress.phase = "Fetching movie backdrops...";
    backupProgress.current = 0;
    backupProgress.total = backdropUrls.length;
    const backdropData = await fetchImagesInBatches(backdropUrls, 30, "backdrops", (current, total) => {
      backupProgress.current = current;
      backupProgress.total = total;
    });
    console.log(`[Backup] Fetched ${backdropData.size}/${backdropUrls.length} backdrops`);

    // Fetch photos
    backupProgress.phase = "Fetching person photos...";
    backupProgress.current = 0;
    backupProgress.total = photoUrls.length;
    const photoData = await fetchImagesInBatches(photoUrls, 30, "photos", (current, total) => {
      backupProgress.current = current;
      backupProgress.total = total;
    });
    console.log(`[Backup] Fetched ${photoData.size}/${photoUrls.length} photos`);

    backupProgress.phase = "Generating backup file...";

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

    backupProgress.phase = "Complete";
    backupProgress.inProgress = false;
    console.log(`[Backup] Complete - ${movies.length} movies, ${people.length} people, ${latentVectors.length} latent vectors, ${featureEmbeddings.length} feature embeddings`);

    // Stream the JSON to avoid memory limits
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        // Helper to write a chunk
        const write = (str: string) => controller.enqueue(encoder.encode(str));

        write('{\n');
        write(`  "version": ${backup.version},\n`);
        write(`  "createdAt": ${JSON.stringify(backup.createdAt)},\n`);

        // Write simple arrays
        const simpleArrays: [string, unknown[]][] = [
          ['users', backup.users],
          ['households', backup.households],
          ['householdMembers', backup.householdMembers],
          ['genres', backup.genres],
          ['studios', backup.studios],
          ['movieGenres', backup.movieGenres],
          ['movieStudios', backup.movieStudios],
          ['movieCast', backup.movieCast],
          ['movieCrew', backup.movieCrew],
          ['genreRankings', backup.genreRankings],
          ['movieRatings', backup.movieRatings],
          ['actorRatings', backup.actorRatings],
          ['directorRatings', backup.directorRatings],
          ['studioRatings', backup.studioRatings],
          ['userSettings', backup.userSettings],
          ['integrationConfigs', backup.integrationConfigs],
          ['latentVectors', backup.latentVectors],
          ['featureEmbeddings', backup.featureEmbeddings],
          ['userFeatureCaches', backup.userFeatureCaches],
          ['radarrSyncs', backup.radarrSyncs],
          ['plexAvailabilities', backup.plexAvailabilities],
          ['activityLogs', backup.activityLogs],
        ];

        for (const [key, arr] of simpleArrays) {
          write(`  "${key}": ${JSON.stringify(arr)},\n`);
        }

        // Write mfModelMetadata
        write(`  "mfModelMetadata": ${JSON.stringify(backup.mfModelMetadata)},\n`);

        // Stream people array (with photos)
        write('  "people": [\n');
        for (let i = 0; i < backup.people.length; i++) {
          const person = backup.people[i];
          write('    ' + JSON.stringify(person));
          write(i < backup.people.length - 1 ? ',\n' : '\n');
        }
        write('  ],\n');

        // Stream movies array (with posters/backdrops - the largest data)
        write('  "movies": [\n');
        for (let i = 0; i < backup.movies.length; i++) {
          const movie = backup.movies[i];
          write('    ' + JSON.stringify(movie));
          write(i < backup.movies.length - 1 ? ',\n' : '\n');
        }
        write('  ]\n');

        write('}\n');
        controller.close();
      },
    });

    return new NextResponse(stream, {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="movie-night-backup-${new Date().toISOString().split("T")[0]}.json"`,
      },
    });
  } catch (error) {
    console.error("[Backup] Error:", error);
    backupProgress.inProgress = false;
    backupProgress.phase = "Error";
    throw error;
  }
}
