import { prisma } from "./prisma";
import type { OMDBMovie } from "./api/omdb";

interface MovieWithRelations {
  cast?: Array<{ person: { name: string } }>;
  crew?: Array<{ job: string; person: { name: string } }>;
  studios?: Array<{ studio: { name: string } }>;
}

export interface MovieMetadataSummary {
  actors: string[];
  directors: string[];
  studios: string[];
  genres: string[];
}

export function splitCsvNames(value: string | undefined, limit = 3): string[] {
  if (!value || value === "N/A") return [];

  return Array.from(
    new Set(
      value
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
    )
  ).slice(0, limit);
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}

export function extractMovieMetadataFromRelations(
  movie: MovieWithRelations | null | undefined
): MovieMetadataSummary {
  const directors = Array.from(
    new Set(
      (movie?.crew || [])
        .filter((crewMember) => crewMember.job.toLowerCase() === "director")
        .map((crewMember) => crewMember.person.name)
        .filter(Boolean)
    )
  ).slice(0, 2);

  const actors = Array.from(
    new Set(
      (movie?.cast || [])
        .map((castMember) => castMember.person.name)
        .filter(Boolean)
    )
  ).slice(0, 3);

  const studios = Array.from(
    new Set(
      (movie?.studios || [])
        .map((studioMember) => studioMember.studio.name)
        .filter(Boolean)
    )
  ).slice(0, 2);

  return { actors, directors, studios, genres: [] };
}

async function findOrCreatePersonIdByName(name: string): Promise<string> {
  const existing = await prisma.person.findFirst({
    where: {
      name: {
        equals: name,
        mode: "insensitive",
      },
    },
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await prisma.person.create({
    data: { name },
    select: { id: true },
  });
  return created.id;
}

export async function syncMovieMetadataFromOMDB(
  movieId: string,
  details: OMDBMovie
): Promise<MovieMetadataSummary> {
  const directors = splitCsvNames(details.Director, 2);
  const actors = splitCsvNames(details.Actors, 3);
  const studios = splitCsvNames(details.Production, 2);
  const genres = splitCsvNames(details.Genre, 4).map((genre) =>
    normalizeGenreName(genre)
  );

  for (const [index, actor] of actors.entries()) {
    const personId = await findOrCreatePersonIdByName(actor);
    await prisma.movieCast.upsert({
      where: {
        movieId_personId: {
          movieId,
          personId,
        },
      },
      create: {
        movieId,
        personId,
        castOrder: index,
      },
      update: {
        castOrder: index,
      },
    });
  }

  for (const director of directors) {
    const personId = await findOrCreatePersonIdByName(director);
    await prisma.movieCrew.upsert({
      where: {
        movieId_personId_job: {
          movieId,
          personId,
          job: "Director",
        },
      },
      create: {
        movieId,
        personId,
        job: "Director",
      },
      update: {},
    });
  }

  for (const studioName of studios) {
    const slug = slugify(studioName);
    if (!slug) continue;

    const studio = await prisma.studio.upsert({
      where: { slug },
      create: {
        name: studioName,
        slug,
      },
      update: {
        name: studioName,
      },
      select: { id: true },
    });

    await prisma.movieStudio.upsert({
      where: {
        movieId_studioId: {
          movieId,
          studioId: studio.id,
        },
      },
      create: {
        movieId,
        studioId: studio.id,
      },
      update: {},
    });
  }

  for (const genreName of genres) {
    const slug = slugify(genreName);
    if (!slug) continue;

    const genre = await prisma.genre.upsert({
      where: { slug },
      create: {
        name: genreName,
        slug,
      },
      update: {
        name: genreName,
      },
      select: { id: true },
    });

    await prisma.movieGenre.upsert({
      where: {
        movieId_genreId: {
          movieId,
          genreId: genre.id,
        },
      },
      create: {
        movieId,
        genreId: genre.id,
      },
      update: {},
    });
  }

  return { actors, directors, studios, genres };
}

function normalizeGenreName(genreName: string): string {
  const normalized = genreName.trim();
  if (!normalized) return normalized;

  if (normalized.toLowerCase() === "sci-fi") {
    return "Science Fiction";
  }

  return normalized;
}
