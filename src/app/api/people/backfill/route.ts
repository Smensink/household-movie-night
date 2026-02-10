import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isInternalOrAdmin } from "@/lib/internal-auth";
import { backfillMLDataForMovie } from "@/lib/ml-backfill";
import {
  getTMDBPerson,
  getTMDBPersonByName,
  getTMDBMovie,
  getTMDBPosterUrl,
  getTMDBProfileUrl,
} from "@/lib/api/tmdb";

const MIN_MOVIES_PER_PERSON = 3;
const MAX_QUEUE_ITEMS_TO_BACKFILL = 50; // Only backfill next ~50 items likely to appear in rating queues
const MAX_MOVIES_PER_PERSON = 5;

interface BackfillResult {
  personId: string;
  personName: string;
  tmdbId: string | null;
  moviesAdded: number;
  moviesLinked: number;
  photoUpdated: boolean;
  error?: string;
}

/**
 * POST /api/people/backfill
 * Backfill movies for actors/directors that have fewer than MIN_MOVIES_PER_PERSON linked movies.
 * Limits to MAX_PEOPLE_TO_PROCESS people per run to prevent database bloat.
 */
export async function POST(req: NextRequest) {
  if (!(await isInternalOrAdmin(req))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  console.log("[People Backfill] Starting actor/director movie backfill...");
  const results: BackfillResult[] = [];

  // Find actors likely to appear in rating queues but with incomplete movie data
  // Priority: those in highly-rated movies, or those connected to rated genres/movies
  const actors = await prisma.person.findMany({
    where: {
      moviesCast: {
        some: {
          movie: {
            // Must have poster and basic data (quality items likely to be recommended)
            posterUrl: { not: null },
          },
        },
      },
    },
    select: {
      id: true,
      name: true,
      tmdbId: true,
      photoUrl: true,
      _count: {
        select: { moviesCast: true },
      },
      moviesCast: {
        select: {
          movie: {
            select: {
              voteAverage: true,
              popularity: true,
            },
          },
        },
        take: 10,
      },
    },
  });

  // Score actors by quality of movies they're in (proxy for queue appearance likelihood)
  const scoredActors = actors
    .filter((a) => a._count.moviesCast < MIN_MOVIES_PER_PERSON)
    .map((actor) => {
      const avgQuality =
        actor.moviesCast.length > 0
          ? actor.moviesCast.reduce(
              (sum, c) =>
                sum + (c.movie.voteAverage ?? 0) * 0.7 + (c.movie.popularity ?? 0) * 0.003,
              0
            ) / actor.moviesCast.length
          : 0;
      return { ...actor, queueScore: avgQuality };
    })
    .sort((a, b) => b.queueScore - a.queueScore)
    .slice(0, MAX_QUEUE_ITEMS_TO_BACKFILL);

  // Find directors likely to appear in rating queues
  const directors = await prisma.person.findMany({
    where: {
      moviesCrew: {
        some: {
          job: "Director",
          movie: {
            posterUrl: { not: null },
          },
        },
      },
    },
    select: {
      id: true,
      name: true,
      tmdbId: true,
      photoUrl: true,
      _count: {
        select: { moviesCrew: true },
      },
      moviesCrew: {
        where: { job: "Director" },
        select: {
          movie: {
            select: {
              voteAverage: true,
              popularity: true,
            },
          },
        },
        take: 10,
      },
    },
  });

  // Score directors by quality of movies they directed
  const scoredDirectors = directors
    .filter((d) => d._count.moviesCrew < MIN_MOVIES_PER_PERSON)
    .map((director) => {
      const avgQuality =
        director.moviesCrew.length > 0
          ? director.moviesCrew.reduce(
              (sum, c) =>
                sum + (c.movie.voteAverage ?? 0) * 0.7 + (c.movie.popularity ?? 0) * 0.003,
              0
            ) / director.moviesCrew.length
          : 0;
      return { ...director, queueScore: avgQuality };
    })
    .sort((a, b) => b.queueScore - a.queueScore)
    .slice(0, MAX_QUEUE_ITEMS_TO_BACKFILL);

  const actorsToBackfill = scoredActors;
  const directorsToBackfill = scoredDirectors;

  // Process actors
  for (const person of actorsToBackfill) {
    const result = await backfillPersonMovies(person, "cast");
    results.push(result);
  }

  // Process directors
  for (const person of directorsToBackfill) {
    const result = await backfillPersonMovies(person, "crew");
    results.push(result);
  }

  const summary = {
    actorsProcessed: actorsToBackfill.length,
    directorsProcessed: directorsToBackfill.length,
    totalMoviesAdded: results.reduce((sum, r) => sum + r.moviesAdded, 0),
    totalMoviesLinked: results.reduce((sum, r) => sum + r.moviesLinked, 0),
    photosUpdated: results.filter((r) => r.photoUpdated).length,
    errors: results.filter((r) => r.error).length,
  };

  console.log(`[People Backfill] Complete: ${summary.actorsProcessed} actors, ${summary.directorsProcessed} directors, ${summary.totalMoviesAdded} movies added`);

  return NextResponse.json({ summary, results });
}

async function backfillPersonMovies(
  person: {
    id: string;
    name: string;
    tmdbId: string | null;
    photoUrl: string | null;
  },
  type: "cast" | "crew"
): Promise<BackfillResult> {
  const result: BackfillResult = {
    personId: person.id,
    personName: person.name,
    tmdbId: person.tmdbId,
    moviesAdded: 0,
    moviesLinked: 0,
    photoUpdated: false,
  };

  try {
    // Get TMDB ID if we don't have it
    let tmdbId = person.tmdbId ? parseInt(person.tmdbId, 10) : null;

    if (!tmdbId) {
      const searchResult = await getTMDBPersonByName(person.name);
      if (!searchResult) {
        result.error = "Person not found on TMDB";
        return result;
      }
      tmdbId = searchResult.id;
      result.tmdbId = String(tmdbId);

      // Update person with TMDB ID
      await prisma.person.update({
        where: { id: person.id },
        data: { tmdbId: String(tmdbId) },
      });
    }

    // Get full person details with movie credits
    const tmdbPerson = await getTMDBPerson(tmdbId);
    if (!tmdbPerson) {
      result.error = "Could not fetch TMDB person details";
      return result;
    }

    // Update photo if missing
    if (!person.photoUrl && tmdbPerson.profile_path) {
      const photoUrl = getTMDBProfileUrl(tmdbPerson.profile_path);
      if (photoUrl) {
        await prisma.person.update({
          where: { id: person.id },
          data: { photoUrl },
        });
        result.photoUpdated = true;
      }
    }

    // Get movies based on type
    const castMovies = tmdbPerson.movie_credits?.cast || [];
    const crewMovies = tmdbPerson.movie_credits?.crew?.filter((c) => c.job === "Director") || [];

    // Sort by popularity/rating and take top MAX_MOVIES_PER_PERSON
    // Cast movies have vote_average, crew movies don't so we use release_date as proxy
    const topMovies =
      type === "cast"
        ? castMovies
            .sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0))
            .slice(0, MAX_MOVIES_PER_PERSON)
        : crewMovies
            .sort((a, b) => {
              // For directors, sort by release date (newer = more relevant)
              const dateA = a.release_date ? new Date(a.release_date).getTime() : 0;
              const dateB = b.release_date ? new Date(b.release_date).getTime() : 0;
              return dateB - dateA;
            })
            .slice(0, MAX_MOVIES_PER_PERSON);

    for (const tmdbMovie of topMovies) {
      // Get full movie details
      const movieDetails = await getTMDBMovie(tmdbMovie.id);
      if (!movieDetails) continue;

      const tmdbMovieId = String(movieDetails.id);
      const year = movieDetails.release_date
        ? parseInt(movieDetails.release_date.slice(0, 4), 10)
        : null;

      // Check if movie already exists
      let existingMovie = await prisma.movie.findFirst({
        where: {
          OR: [
            { tmdbId: tmdbMovieId },
            ...(movieDetails.imdb_id ? [{ imdbId: movieDetails.imdb_id }] : []),
          ],
        },
        select: { id: true },
      });

      if (!existingMovie) {
        // Create the movie
        const posterUrl = getTMDBPosterUrl(movieDetails.poster_path, "w780");

        existingMovie = await prisma.movie.create({
          data: {
            tmdbId: tmdbMovieId,
            imdbId: movieDetails.imdb_id || null,
            title: movieDetails.title,
            year: isNaN(year || NaN) ? null : year,
            posterUrl,
            overview: movieDetails.overview || null,
            runtime: movieDetails.runtime || null,
            voteAverage: movieDetails.vote_average,
          },
          select: { id: true },
        });
        if (movieDetails.imdb_id) await backfillMLDataForMovie(existingMovie.id, movieDetails.imdb_id);
        result.moviesAdded++;

        // Add genres
        if (movieDetails.genres) {
          for (const genre of movieDetails.genres) {
            const slug = genre.name.toLowerCase().replace(/\s+/g, "-");
            await prisma.genre.upsert({
              where: { slug },
              create: { name: genre.name, slug },
              update: {},
            });

            const dbGenre = await prisma.genre.findUnique({
              where: { slug },
              select: { id: true },
            });

            if (dbGenre) {
              await prisma.movieGenre.upsert({
                where: {
                  movieId_genreId: {
                    movieId: existingMovie.id,
                    genreId: dbGenre.id,
                  },
                },
                create: {
                  movieId: existingMovie.id,
                  genreId: dbGenre.id,
                },
                update: {},
              });
            }
          }
        }
      }

      // Link person to movie
      if (type === "cast") {
        const existingCast = await prisma.movieCast.findUnique({
          where: {
            movieId_personId: {
              movieId: existingMovie.id,
              personId: person.id,
            },
          },
        });

        if (!existingCast) {
          const castInfo = tmdbPerson.movie_credits?.cast?.find(
            (c) => c.id === tmdbMovie.id
          );
          await prisma.movieCast.create({
            data: {
              movieId: existingMovie.id,
              personId: person.id,
              character: castInfo?.character || null,
              castOrder: 0,
            },
          });
          result.moviesLinked++;
        }
      } else {
        const existingCrew = await prisma.movieCrew.findUnique({
          where: {
            movieId_personId_job: {
              movieId: existingMovie.id,
              personId: person.id,
              job: "Director",
            },
          },
        });

        if (!existingCrew) {
          await prisma.movieCrew.create({
            data: {
              movieId: existingMovie.id,
              personId: person.id,
              job: "Director",
            },
          });
          result.moviesLinked++;
        }
      }
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : "Unknown error";
  }

  return result;
}

/**
 * GET /api/people/backfill
 * Check status of people that need backfill
 */
export async function GET(req: NextRequest) {
  if (!(await isInternalOrAdmin(req))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const actors = await prisma.person.findMany({
    where: {
      moviesCast: { some: {} },
    },
    select: {
      id: true,
      name: true,
      _count: {
        select: { moviesCast: true },
      },
    },
    orderBy: {
      moviesCast: { _count: "desc" },
    },
  });

  const actorsNeedingBackfill = actors.filter(
    (a) => a._count.moviesCast < MIN_MOVIES_PER_PERSON
  );

  const directors = await prisma.person.findMany({
    where: {
      moviesCrew: {
        some: { job: "Director" },
      },
    },
    select: {
      id: true,
      name: true,
      _count: {
        select: { moviesCrew: true },
      },
    },
    orderBy: {
      moviesCrew: { _count: "desc" },
    },
  });

  const directorsNeedingBackfill = directors.filter(
    (d) => d._count.moviesCrew < MIN_MOVIES_PER_PERSON
  );

  return NextResponse.json({
    minMoviesRequired: MIN_MOVIES_PER_PERSON,
    maxQueueItemsToBackfill: MAX_QUEUE_ITEMS_TO_BACKFILL,
    actors: {
      total: actors.length,
      needingBackfill: actorsNeedingBackfill.length,
      sample: actorsNeedingBackfill.slice(0, 10).map((a) => ({
        id: a.id,
        name: a.name,
        movieCount: a._count.moviesCast,
      })),
    },
    directors: {
      total: directors.length,
      needingBackfill: directorsNeedingBackfill.length,
      sample: directorsNeedingBackfill.slice(0, 10).map((d) => ({
        id: d.id,
        name: d.name,
        movieCount: d._count.moviesCrew,
      })),
    },
  });
}
