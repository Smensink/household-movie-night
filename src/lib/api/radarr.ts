import { prisma } from "../prisma";

interface RadarrConfig {
  baseUrl: string;
  apiKey: string;
}

interface RadarrRootFolder {
  path: string;
  accessible: boolean;
  freeSpace: number;
  totalSpace: number;
}

interface RadarrQualityProfile {
  id: number;
  name: string;
}

interface RadarrMovie {
  id: number;
  title: string;
  tmdbId: number;
  imdbId?: string;
  year?: number;
  overview?: string;
  runtime?: number;
  hasFile: boolean;
  monitored: boolean;
  images?: { coverType: string; remoteUrl?: string }[];
  genres?: string[];
}

async function getRadarrConfig(): Promise<RadarrConfig | null> {
  const config = await prisma.integrationConfig.findUnique({
    where: { service: "radarr" },
  });
  if (!config?.enabled || !config.baseUrl || !config.apiKey) return null;
  return { baseUrl: config.baseUrl.replace(/\/$/, ""), apiKey: config.apiKey };
}

async function getRadarrDefaults(config: RadarrConfig): Promise<{
  rootFolder: string | null;
  qualityProfileId: number | null;
}> {
  try {
    // Get root folders
    const foldersRes = await fetch(`${config.baseUrl}/api/v3/rootfolder`, {
      headers: { "X-Api-Key": config.apiKey },
      cache: "no-store",
    });

    let rootFolder: string | null = null;
    if (foldersRes.ok) {
      const folders: RadarrRootFolder[] = await foldersRes.json();
      // Pick first accessible folder
      const accessibleFolder = folders.find((f) => f.accessible);
      rootFolder = accessibleFolder?.path || folders[0]?.path || null;
    }

    // Get quality profiles
    const profilesRes = await fetch(`${config.baseUrl}/api/v3/qualityprofile`, {
      headers: { "X-Api-Key": config.apiKey },
      cache: "no-store",
    });

    let qualityProfileId: number | null = null;
    if (profilesRes.ok) {
      const profiles: RadarrQualityProfile[] = await profilesRes.json();
      // Prefer HD-1080p or Any profile, fallback to first
      const preferredProfile =
        profiles.find((p) => p.name.toLowerCase().includes("1080p")) ||
        profiles.find((p) => p.name.toLowerCase().includes("any")) ||
        profiles[0];
      qualityProfileId = preferredProfile?.id || null;
    }

    return { rootFolder, qualityProfileId };
  } catch (error) {
    console.error("Failed to get Radarr defaults:", error);
    return { rootFolder: null, qualityProfileId: null };
  }
}

export async function getRadarrMovies(): Promise<RadarrMovie[]> {
  const config = await getRadarrConfig();
  if (!config) return [];

  try {
    const res = await fetch(`${config.baseUrl}/api/v3/movie`, {
      headers: { "X-Api-Key": config.apiKey },
      cache: "no-store",
    });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

/**
 * Sync all Radarr movie availability to our database
 * This updates which movies are downloaded and available
 */
export async function syncRadarrAvailability(): Promise<{
  updated: number;
  added: number;
  total: number;
}> {
  const radarrMovies = await getRadarrMovies();
  if (radarrMovies.length === 0) {
    return { updated: 0, added: 0, total: 0 };
  }

  let updated = 0;
  let added = 0;

  for (const radarrMovie of radarrMovies) {
    const tmdbId = radarrMovie.tmdbId?.toString();
    if (!tmdbId) continue;

    // Find matching movie in our database
    const movie = await prisma.movie.findUnique({
      where: { tmdbId },
      select: { id: true },
    });

    if (!movie) continue;

    // Upsert RadarrSync record
    const existing = await prisma.radarrSync.findUnique({
      where: { movieId: movie.id },
    });

    await prisma.radarrSync.upsert({
      where: { movieId: movie.id },
      create: {
        movieId: movie.id,
        radarrId: radarrMovie.id,
        monitored: radarrMovie.monitored,
        available: radarrMovie.hasFile,
      },
      update: {
        radarrId: radarrMovie.id,
        monitored: radarrMovie.monitored,
        available: radarrMovie.hasFile,
      },
    });

    if (existing) {
      updated++;
    } else {
      added++;
    }
  }

  return { updated, added, total: radarrMovies.length };
}

/**
 * Import all movies from Radarr library into our database
 * This creates movie records for movies we don't have yet
 */
export async function importRadarrLibrary(): Promise<{
  imported: number;
  skipped: number;
  total: number;
}> {
  console.log("[Radarr Import] Starting Radarr library import...");

  const radarrMovies = await getRadarrMovies();
  if (radarrMovies.length === 0) {
    console.log("[Radarr Import] No movies found in Radarr or Radarr not configured");
    return { imported: 0, skipped: 0, total: 0 };
  }

  let imported = 0;
  let skipped = 0;

  for (const radarrMovie of radarrMovies) {
    const tmdbId = radarrMovie.tmdbId?.toString();
    if (!tmdbId) {
      skipped++;
      continue;
    }

    // Check if movie already exists in our database
    const existing = await prisma.movie.findFirst({
      where: {
        OR: [
          { tmdbId },
          ...(radarrMovie.imdbId ? [{ imdbId: radarrMovie.imdbId }] : []),
        ],
      },
      select: { id: true },
    });

    if (existing) {
      // Update RadarrSync for existing movie
      await prisma.radarrSync.upsert({
        where: { movieId: existing.id },
        create: {
          movieId: existing.id,
          radarrId: radarrMovie.id,
          monitored: radarrMovie.monitored,
          available: radarrMovie.hasFile,
        },
        update: {
          radarrId: radarrMovie.id,
          monitored: radarrMovie.monitored,
          available: radarrMovie.hasFile,
        },
      });
      skipped++;
      continue;
    }

    // Extract poster URL from Radarr images
    let posterUrl: string | null = null;
    if (radarrMovie.images) {
      const posterImage = radarrMovie.images.find((img) => img.coverType === "poster");
      posterUrl = posterImage?.remoteUrl || null;
    }

    // Get era from year
    let era: string | null = null;
    if (radarrMovie.year) {
      const currentYear = new Date().getFullYear();
      if (radarrMovie.year >= currentYear - 1) era = "new_release";
      else if (radarrMovie.year >= 2000) era = "modern_classic";
      else era = "classic";
    }

    try {
      // Create the movie
      const movie = await prisma.movie.create({
        data: {
          tmdbId,
          imdbId: radarrMovie.imdbId || null,
          title: radarrMovie.title,
          year: radarrMovie.year || null,
          posterUrl,
          overview: radarrMovie.overview || null,
          runtime: radarrMovie.runtime || null,
          era,
        },
        select: { id: true },
      });

      // Create RadarrSync record
      await prisma.radarrSync.create({
        data: {
          movieId: movie.id,
          radarrId: radarrMovie.id,
          monitored: radarrMovie.monitored,
          available: radarrMovie.hasFile,
        },
      });

      // Link genres if available
      if (radarrMovie.genres && radarrMovie.genres.length > 0) {
        for (const genreName of radarrMovie.genres) {
          const slug = genreName.toLowerCase().replace(/\s+/g, "-");
          try {
            await prisma.genre.upsert({
              where: { slug },
              create: { name: genreName, slug },
              update: {},
            });

            const genre = await prisma.genre.findUnique({
              where: { slug },
              select: { id: true },
            });

            if (genre) {
              await prisma.movieGenre.upsert({
                where: {
                  movieId_genreId: { movieId: movie.id, genreId: genre.id },
                },
                create: { movieId: movie.id, genreId: genre.id },
                update: {},
              });
            }
          } catch {
            // Ignore genre linking errors
          }
        }
      }

      imported++;
    } catch {
      // Skip on error (e.g., duplicate)
      skipped++;
    }
  }

  console.log(`[Radarr Import] Complete: ${imported} imported, ${skipped} skipped, ${radarrMovies.length} total in Radarr`);

  return { imported, skipped, total: radarrMovies.length };
}

export interface AddToRadarrResult {
  success: boolean;
  radarrId?: number;
  error?: string;
  alreadyExists?: boolean;
}

export async function addToRadarr(
  tmdbId: string,
  title: string
): Promise<AddToRadarrResult> {
  const config = await getRadarrConfig();
  if (!config) {
    return { success: false, error: "Radarr not configured" };
  }

  // Check if movie already exists in Radarr
  const existing = await checkRadarrAvailability(tmdbId);
  if (existing.radarrId) {
    return { success: true, alreadyExists: true, radarrId: existing.radarrId };
  }

  // Get defaults
  const { rootFolder, qualityProfileId } = await getRadarrDefaults(config);

  if (!rootFolder) {
    return { success: false, error: "No root folder configured in Radarr" };
  }

  if (!qualityProfileId) {
    return { success: false, error: "No quality profile found in Radarr" };
  }

  const payload = {
    title,
    tmdbId: parseInt(tmdbId, 10),
    qualityProfileId,
    rootFolderPath: rootFolder,
    monitored: true,
    addOptions: {
      searchForMovie: true,
      monitor: "movieOnly",
    },
  };

  try {
    const res = await fetch(`${config.baseUrl}/api/v3/movie`, {
      method: "POST",
      headers: {
        "X-Api-Key": config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errorText = await res.text();
      return {
        success: false,
        error: `Radarr API error: ${res.status} - ${errorText}`,
      };
    }

    const result: RadarrMovie = await res.json();
    return { success: true, radarrId: result.id };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function checkRadarrAvailability(tmdbId: string): Promise<{
  available: boolean;
  monitored: boolean;
  radarrId?: number;
}> {
  const config = await getRadarrConfig();
  if (!config) return { available: false, monitored: false };

  try {
    const res = await fetch(`${config.baseUrl}/api/v3/movie?tmdbId=${tmdbId}`, {
      headers: { "X-Api-Key": config.apiKey },
      cache: "no-store",
    });

    if (!res.ok) return { available: false, monitored: false };

    const movies: RadarrMovie[] = await res.json();
    if (movies.length === 0) return { available: false, monitored: false };

    return {
      available: movies[0].hasFile || false,
      monitored: movies[0].monitored || false,
      radarrId: movies[0].id,
    };
  } catch {
    return { available: false, monitored: false };
  }
}

/**
 * Get movies ranked by average household rating that aren't in Radarr yet
 */
export async function getTopRatedMoviesForRadarr(limit = 10): Promise<{
  id: string;
  title: string;
  tmdbId: string;
  avgRating: number;
  ratingCount: number;
}[]> {
  // Get all movies with ratings, not yet in Radarr
  const movies = await prisma.movie.findMany({
    where: {
      tmdbId: { not: null },
      radarrSync: null, // Not already in Radarr
    },
    include: {
      ratings: {
        where: {
          rating: { not: null },
          hasSeen: false, // Only want-to-watch ratings
        },
        select: { rating: true },
      },
    },
  });

  // Calculate average rating for each movie
  const moviesWithAvg = movies
    .map((movie) => {
      const ratings = movie.ratings
        .filter((r) => r.rating !== null)
        .map((r) => r.rating as number);

      if (ratings.length === 0) return null;

      const avgRating = ratings.reduce((sum, r) => sum + r, 0) / ratings.length;

      return {
        id: movie.id,
        title: movie.title,
        tmdbId: movie.tmdbId as string,
        avgRating,
        ratingCount: ratings.length,
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null)
    .sort((a, b) => {
      // Sort by average rating first, then by count for tiebreaker
      if (b.avgRating !== a.avgRating) return b.avgRating - a.avgRating;
      return b.ratingCount - a.ratingCount;
    })
    .slice(0, limit);

  return moviesWithAvg;
}

/**
 * Sync top N rated movies to Radarr
 * Returns the list of movies that were added or already exist
 */
export async function syncTopRatedToRadarr(count = 10): Promise<{
  added: { movieId: string; title: string; radarrId?: number }[];
  alreadyInRadarr: { movieId: string; title: string }[];
  failed: { movieId: string; title: string; error: string }[];
}> {
  const topMovies = await getTopRatedMoviesForRadarr(count);

  const added: { movieId: string; title: string; radarrId?: number }[] = [];
  const alreadyInRadarr: { movieId: string; title: string }[] = [];
  const failed: { movieId: string; title: string; error: string }[] = [];

  for (const movie of topMovies) {
    const result = await addToRadarr(movie.tmdbId, movie.title);

    if (result.success) {
      if (result.alreadyExists) {
        alreadyInRadarr.push({ movieId: movie.id, title: movie.title });
      } else {
        added.push({ movieId: movie.id, title: movie.title, radarrId: result.radarrId });
      }

      // Create RadarrSync record
      await prisma.radarrSync.upsert({
        where: { movieId: movie.id },
        create: {
          movieId: movie.id,
          radarrId: result.radarrId,
          monitored: true,
          available: result.alreadyExists || false,
        },
        update: {
          radarrId: result.radarrId,
          monitored: true,
        },
      });
    } else {
      failed.push({ movieId: movie.id, title: movie.title, error: result.error || "Unknown error" });
    }
  }

  return { added, alreadyInRadarr, failed };
}

/**
 * Add the next highest-rated movie to Radarr (used when a movie is watched)
 */
export async function addNextTopRatedToRadarr(): Promise<{
  success: boolean;
  movie?: { id: string; title: string; avgRating: number };
  error?: string;
}> {
  const topMovies = await getTopRatedMoviesForRadarr(1);

  if (topMovies.length === 0) {
    return { success: false, error: "No more movies to add" };
  }

  const movie = topMovies[0];
  const result = await addToRadarr(movie.tmdbId, movie.title);

  if (result.success) {
    await prisma.radarrSync.upsert({
      where: { movieId: movie.id },
      create: {
        movieId: movie.id,
        radarrId: result.radarrId,
        monitored: true,
        available: false,
      },
      update: {
        radarrId: result.radarrId,
        monitored: true,
      },
    });

    return {
      success: true,
      movie: { id: movie.id, title: movie.title, avgRating: movie.avgRating },
    };
  }

  return { success: false, error: result.error };
}

// Sync movies with strong consensus to Radarr
export async function syncMoviesToRadarr(
  movieIds: string[]
): Promise<
  { movieId: string; title: string; result: AddToRadarrResult }[]
> {
  const config = await getRadarrConfig();
  if (!config) {
    throw new Error("Radarr not configured");
  }

  const movies = await prisma.movie.findMany({
    where: {
      id: { in: movieIds },
      tmdbId: { not: null },
    },
  });

  const results: { movieId: string; title: string; result: AddToRadarrResult }[] = [];

  for (const movie of movies) {
    if (!movie.tmdbId) continue;

    const result = await addToRadarr(movie.tmdbId, movie.title);

    // Create or update RadarrSync record on success
    if (result.success) {
      await prisma.radarrSync.upsert({
        where: { movieId: movie.id },
        create: {
          movieId: movie.id,
          radarrId: result.radarrId,
          monitored: true,
          available: result.alreadyExists || false,
        },
        update: {
          radarrId: result.radarrId,
          monitored: true,
        },
      });
    }

    results.push({
      movieId: movie.id,
      title: movie.title,
      result,
    });
  }

  return results;
}
