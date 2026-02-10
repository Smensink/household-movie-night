import { prisma } from "./prisma";
import type { OMDBMovie } from "./api/omdb";
import type { TMDBMovie } from "./api/tmdb";

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

  try {
    const created = await prisma.person.create({
      data: { name },
      select: { id: true },
    });
    return created.id;
  } catch {
    // Handle race condition: another request may have created this person
    const retried = await prisma.person.findFirst({
      where: { name: { equals: name, mode: "insensitive" } },
      select: { id: true },
    });
    if (retried) return retried.id;
    throw new Error(`Failed to find or create person: ${name}`);
  }
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

    try {
      // First try to find by slug or name
      let studio = await prisma.studio.findFirst({
        where: {
          OR: [{ slug }, { name: studioName }],
        },
        select: { id: true },
      });

      if (!studio) {
        studio = await prisma.studio.create({
          data: { name: studioName, slug },
          select: { id: true },
        });
      }

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
    } catch {
      // Skip this studio if there's a constraint error
    }
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

/**
 * Sync movie metadata (studios, cast, crew) from TMDB
 * Use this as fallback when OMDB doesn't provide production company data
 */
export async function syncMovieMetadataFromTMDB(
  movieId: string,
  tmdbMovie: TMDBMovie
): Promise<{ studios: string[]; actors: string[]; directors: string[] }> {
  const studios: string[] = [];
  const actors: string[] = [];
  const directors: string[] = [];

  // Sync genres (TMDB provides a normalized genre list).
  if (tmdbMovie.genres) {
    for (const g of tmdbMovie.genres.slice(0, 6)) {
      if (!g.name) continue;
      const genreName = normalizeGenreName(g.name);
      const slug = slugify(genreName);
      if (!slug) continue;

      const genre = await prisma.genre.upsert({
        where: { slug },
        create: { name: genreName, slug },
        update: { name: genreName },
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
  }

  // Sync production companies as studios
  if (tmdbMovie.production_companies) {
    for (const company of tmdbMovie.production_companies.slice(0, 3)) {
      if (!company.name) continue;
      const slug = slugify(company.name);
      if (!slug) continue;

      try {
        studios.push(company.name);

        // First try to find by slug or name
        let studio = await prisma.studio.findFirst({
          where: {
            OR: [{ slug }, { name: company.name }],
          },
          select: { id: true },
        });

        if (!studio) {
          studio = await prisma.studio.create({
            data: { name: company.name, slug },
            select: { id: true },
          });
        }

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
      } catch {
        // Skip this studio if there's a constraint error
      }
    }
  }

  // Sync cast (actors)
  if (tmdbMovie.credits?.cast) {
    for (const castMember of tmdbMovie.credits.cast.slice(0, 5)) {
      if (!castMember.name) continue;
      actors.push(castMember.name);

      const personId = await findOrCreatePersonIdByName(castMember.name);

      // Update person with TMDB ID and photo if available
      if (castMember.profile_path) {
        await prisma.person.update({
          where: { id: personId },
          data: {
            tmdbId: castMember.id.toString(),
            photoUrl: `https://image.tmdb.org/t/p/h632${castMember.profile_path}`,
          },
        });
      }

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
          castOrder: castMember.order,
        },
        update: {
          castOrder: castMember.order,
        },
      });
    }
  }

  // Sync crew (directors)
  if (tmdbMovie.credits?.crew) {
    for (const crewMember of tmdbMovie.credits.crew) {
      if (crewMember.job !== "Director" || !crewMember.name) continue;
      directors.push(crewMember.name);

      const personId = await findOrCreatePersonIdByName(crewMember.name);

      // Update person with TMDB ID and photo if available
      if (crewMember.profile_path) {
        await prisma.person.update({
          where: { id: personId },
          data: {
            tmdbId: crewMember.id.toString(),
            photoUrl: `https://image.tmdb.org/t/p/h632${crewMember.profile_path}`,
          },
        });
      }

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
  }

  return { studios, actors, directors };
}
