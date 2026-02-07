import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const SUPPORTED_VERSIONS = [1];

interface BackupData {
  version: number;
  createdAt: string;
  users?: {
    id: string;
    email: string | null;
    name: string;
    passwordHash: string | null;
    avatarUrl: string | null;
    isGuest: boolean;
  }[];
  households?: {
    id: string;
    name: string;
    inviteCode: string;
  }[];
  householdMembers?: {
    userId: string;
    householdId: string;
    role: string;
  }[];
  genreRankings?: {
    userId: string;
    genreId: string;
    rank: number;
  }[];
  movieRatings?: {
    userId: string;
    movieId: string;
    rating: number | null;
    hasSeen: boolean;
    notHeardOf: boolean;
  }[];
  actorRatings?: {
    userId: string;
    personId: string;
    rating: number | null;
    notHeardOf: boolean;
  }[];
  directorRatings?: {
    userId: string;
    personId: string;
    rating: number | null;
    notHeardOf: boolean;
  }[];
  studioRatings?: {
    userId: string;
    studioId: string;
    rating: number | null;
    notHeardOf: boolean;
  }[];
  userSettings?: {
    userId: string;
    explorationFactor: number;
    discoverySourcePref: string;
  }[];
  genres?: { id: string; name: string; slug: string }[];
  studios?: { id: string; name: string; slug: string }[];
  people?: {
    id: string;
    tmdbId: string | null;
    name: string;
    photoUrl: string | null;
    knownFor: string | null;
  }[];
  movies?: {
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
  movieGenres?: { movieId: string; genreId: string }[];
  movieStudios?: { movieId: string; studioId: string }[];
  movieCast?: {
    movieId: string;
    personId: string;
    character: string | null;
    castOrder: number | null;
  }[];
  movieCrew?: { movieId: string; personId: string; job: string }[];
  integrationConfigs?: {
    service: string;
    baseUrl: string | null;
    apiKey: string | null;
    enabled: boolean;
  }[];
}

export async function POST(req: NextRequest) {
  // Check if any users exist - if so, require authentication
  const userCount = await prisma.user.count();

  if (userCount > 0) {
    return NextResponse.json(
      {
        error:
          "Users already exist. Please log in as an admin to restore from backup via Settings.",
      },
      { status: 403 }
    );
  }

  let backup: BackupData;
  try {
    backup = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!backup.version || !SUPPORTED_VERSIONS.includes(backup.version)) {
    return NextResponse.json(
      {
        error: `Unsupported backup version. Supported: ${SUPPORTED_VERSIONS.join(", ")}`,
      },
      { status: 400 }
    );
  }

  const stats = {
    users: 0,
    households: 0,
    householdMembers: 0,
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
    skipped: 0,
  };

  // Import users
  for (const user of backup.users || []) {
    try {
      await prisma.user.upsert({
        where: { id: user.id },
        create: {
          id: user.id,
          email: user.email,
          name: user.name,
          passwordHash: user.passwordHash,
          avatarUrl: user.avatarUrl,
          isGuest: user.isGuest,
        },
        update: {
          email: user.email,
          name: user.name,
          passwordHash: user.passwordHash,
          avatarUrl: user.avatarUrl,
          isGuest: user.isGuest,
        },
      });
      stats.users++;
    } catch {
      stats.skipped++;
    }
  }

  // Import households
  for (const household of backup.households || []) {
    try {
      await prisma.household.upsert({
        where: { id: household.id },
        create: {
          id: household.id,
          name: household.name,
          inviteCode: household.inviteCode,
        },
        update: {
          name: household.name,
          inviteCode: household.inviteCode,
        },
      });
      stats.households++;
    } catch {
      stats.skipped++;
    }
  }

  // Import household members
  for (const member of backup.householdMembers || []) {
    try {
      await prisma.householdMember.upsert({
        where: {
          userId_householdId: {
            userId: member.userId,
            householdId: member.householdId,
          },
        },
        create: {
          userId: member.userId,
          householdId: member.householdId,
          role: member.role,
        },
        update: { role: member.role },
      });
      stats.householdMembers++;
    } catch {
      stats.skipped++;
    }
  }

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
        where: {
          movieId_studioId: { movieId: ms.movieId, studioId: ms.studioId },
        },
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
        where: {
          movieId_personId: { movieId: mc.movieId, personId: mc.personId },
        },
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

  // Import genre rankings
  for (const gr of backup.genreRankings || []) {
    try {
      await prisma.genreRanking.upsert({
        where: { userId_genreId: { userId: gr.userId, genreId: gr.genreId } },
        create: { userId: gr.userId, genreId: gr.genreId, rank: gr.rank },
        update: { rank: gr.rank },
      });
      stats.genreRankings++;
    } catch {
      stats.skipped++;
    }
  }

  // Import movie ratings
  for (const mr of backup.movieRatings || []) {
    try {
      await prisma.movieRating.upsert({
        where: { userId_movieId: { userId: mr.userId, movieId: mr.movieId } },
        create: {
          userId: mr.userId,
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

  // Import actor ratings
  for (const ar of backup.actorRatings || []) {
    try {
      await prisma.actorRating.upsert({
        where: { userId_personId: { userId: ar.userId, personId: ar.personId } },
        create: {
          userId: ar.userId,
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

  // Import director ratings
  for (const dr of backup.directorRatings || []) {
    try {
      await prisma.directorRating.upsert({
        where: { userId_personId: { userId: dr.userId, personId: dr.personId } },
        create: {
          userId: dr.userId,
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

  // Import studio ratings
  for (const sr of backup.studioRatings || []) {
    try {
      await prisma.studioRating.upsert({
        where: { userId_studioId: { userId: sr.userId, studioId: sr.studioId } },
        create: {
          userId: sr.userId,
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

  // Import user settings
  for (const us of backup.userSettings || []) {
    try {
      await prisma.userSettings.upsert({
        where: { userId: us.userId },
        create: {
          userId: us.userId,
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

  return NextResponse.json({
    message: "Backup restored successfully",
    backupDate: backup.createdAt,
    stats,
  });
}

// GET endpoint to check if restore is allowed
export async function GET() {
  const userCount = await prisma.user.count();

  return NextResponse.json({
    canRestore: userCount === 0,
    userCount,
  });
}
