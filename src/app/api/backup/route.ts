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
        overview: true,
        runtime: true,
        era: true,
        imdbRating: true,
        rottenTomatoesAudience: true,
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
  };

  return new NextResponse(JSON.stringify(backup, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="movie-night-backup-${new Date().toISOString().split("T")[0]}.json"`,
    },
  });
}
