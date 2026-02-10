import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isInternalOrAdmin } from "@/lib/internal-auth";
import { backfillMLDataForMovie } from "@/lib/ml-backfill";
import {
  searchTMDBCompany,
  getTMDBCompanyMovies,
  getTMDBMovieDetails,
  getTMDBPosterUrl,
} from "@/lib/api/tmdb";

const MIN_MOVIES_PER_STUDIO = 5;
const MAX_QUEUE_ITEMS_TO_BACKFILL = 50; // Only backfill next ~50 items likely to appear in rating queues

interface BackfillResult {
  studioId: string;
  studioName: string;
  tmdbCompanyId: number | null;
  moviesAdded: number;
  moviesLinked: number;
  error?: string;
}

/**
 * POST /api/studios/backfill
 * Backfill popular movies for studios that have fewer than MIN_MOVIES_PER_STUDIO linked movies.
 * This is intended to be run as a background task on startup.
 */
export async function POST(req: NextRequest) {
  if (!(await isInternalOrAdmin(req))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  console.log("[Studio Backfill] Starting studio movie backfill...");
  const results: BackfillResult[] = [];

  // Find studios likely to appear in rating queues but with incomplete movie data
  // Priority: studios with high-quality movies (by rating/popularity)
  const studios = await prisma.studio.findMany({
    where: {
      movies: {
        some: {
          movie: {
            posterUrl: { not: null },
          },
        },
      },
    },
    select: {
      id: true,
      name: true,
      _count: {
        select: { movies: true },
      },
      movies: {
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

  // Score studios by quality of their movies (proxy for queue appearance likelihood)
  const scoredStudios = studios
    .filter((s) => s._count.movies < MIN_MOVIES_PER_STUDIO)
    .map((studio) => {
      const avgQuality =
        studio.movies.length > 0
          ? studio.movies.reduce(
              (sum, m) =>
                sum + (m.movie.voteAverage ?? 0) * 0.7 + (m.movie.popularity ?? 0) * 0.003,
              0
            ) / studio.movies.length
          : 0;
      return { id: studio.id, name: studio.name, queueScore: avgQuality };
    })
    .sort((a, b) => b.queueScore - a.queueScore)
    .slice(0, MAX_QUEUE_ITEMS_TO_BACKFILL);

  const studiosToBackfill = scoredStudios;

  for (const studio of studiosToBackfill) {
    const result: BackfillResult = {
      studioId: studio.id,
      studioName: studio.name,
      tmdbCompanyId: null,
      moviesAdded: 0,
      moviesLinked: 0,
    };

    try {
      // Search TMDB for matching company
      const company = await searchTMDBCompany(studio.name);
      if (!company) {
        result.error = "Company not found on TMDB";
        results.push(result);
        continue;
      }

      result.tmdbCompanyId = company.id;

      // Get popular movies from this company
      const popularMovies = await getTMDBCompanyMovies(
        company.id,
        MIN_MOVIES_PER_STUDIO
      );

      for (const tmdbMovie of popularMovies) {
        // Get full movie details (includes IMDB ID)
        const movieDetails = await getTMDBMovieDetails(tmdbMovie.id);
        if (!movieDetails) continue;

        const tmdbId = String(movieDetails.id);
        const year = movieDetails.release_date
          ? parseInt(movieDetails.release_date.slice(0, 4), 10)
          : null;

        // Check if movie already exists in our database
        let existingMovie = await prisma.movie.findFirst({
          where: {
            OR: [
              { tmdbId },
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
              tmdbId,
              imdbId: movieDetails.imdb_id || null,
              title: movieDetails.title,
              year: isNaN(year || NaN) ? null : year,
              posterUrl,
              overview: movieDetails.overview || null,
              runtime: movieDetails.runtime || null,
            },
            select: { id: true },
          });
          if (movieDetails.imdb_id) await backfillMLDataForMovie(existingMovie.id, movieDetails.imdb_id);
          result.moviesAdded++;

          // Add genres if available
          if (movieDetails.genres && movieDetails.genres.length > 0) {
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

          // Add cast if available
          if (movieDetails.credits?.cast) {
            const topCast = movieDetails.credits.cast.slice(0, 5);
            for (const castMember of topCast) {
              // Upsert person
              const person = await prisma.person.upsert({
                where: { tmdbId: String(castMember.id) },
                create: {
                  tmdbId: String(castMember.id),
                  name: castMember.name,
                  photoUrl: castMember.profile_path
                    ? `https://image.tmdb.org/t/p/w185${castMember.profile_path}`
                    : null,
                  knownFor: "Acting",
                },
                update: {},
              });

              await prisma.movieCast.upsert({
                where: {
                  movieId_personId: {
                    movieId: existingMovie.id,
                    personId: person.id,
                  },
                },
                create: {
                  movieId: existingMovie.id,
                  personId: person.id,
                  character: castMember.character || null,
                  castOrder: castMember.order,
                },
                update: {},
              });
            }
          }

          // Add director if available
          if (movieDetails.credits?.crew) {
            const directors = movieDetails.credits.crew.filter(
              (c) => c.job === "Director"
            );
            for (const director of directors) {
              const person = await prisma.person.upsert({
                where: { tmdbId: String(director.id) },
                create: {
                  tmdbId: String(director.id),
                  name: director.name,
                  photoUrl: director.profile_path
                    ? `https://image.tmdb.org/t/p/w185${director.profile_path}`
                    : null,
                  knownFor: "Directing",
                },
                update: {},
              });

              await prisma.movieCrew.upsert({
                where: {
                  movieId_personId_job: {
                    movieId: existingMovie.id,
                    personId: person.id,
                    job: "Director",
                  },
                },
                create: {
                  movieId: existingMovie.id,
                  personId: person.id,
                  job: "Director",
                },
                update: {},
              });
            }
          }
        }

        // Link movie to studio if not already linked
        const existingLink = await prisma.movieStudio.findUnique({
          where: {
            movieId_studioId: {
              movieId: existingMovie.id,
              studioId: studio.id,
            },
          },
        });

        if (!existingLink) {
          await prisma.movieStudio.create({
            data: {
              movieId: existingMovie.id,
              studioId: studio.id,
            },
          });
          result.moviesLinked++;
        }
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : "Unknown error";
    }

    results.push(result);
  }

  const summary = {
    studiosProcessed: results.length,
    totalMoviesAdded: results.reduce((sum, r) => sum + r.moviesAdded, 0),
    totalMoviesLinked: results.reduce((sum, r) => sum + r.moviesLinked, 0),
    errors: results.filter((r) => r.error).length,
  };

  console.log(`[Studio Backfill] Complete: ${summary.studiosProcessed} studios, ${summary.totalMoviesAdded} added, ${summary.totalMoviesLinked} linked`);

  return NextResponse.json({ summary, results });
}

/**
 * GET /api/studios/backfill
 * Check status of studios that need backfill
 */
export async function GET(req: NextRequest) {
  if (!(await isInternalOrAdmin(req))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const studios = await prisma.studio.findMany({
    where: {
      movies: { some: {} },
    },
    select: {
      id: true,
      name: true,
      _count: {
        select: { movies: true },
      },
    },
    orderBy: {
      movies: { _count: "desc" },
    },
  });

  const needsBackfill = studios.filter(
    (s) => s._count.movies < MIN_MOVIES_PER_STUDIO
  );

  return NextResponse.json({
    totalStudios: studios.length,
    studiosNeedingBackfill: needsBackfill.length,
    maxQueueItemsToBackfill: MAX_QUEUE_ITEMS_TO_BACKFILL,
    minMoviesRequired: MIN_MOVIES_PER_STUDIO,
    studios: needsBackfill.slice(0, 20).map((s) => ({
      id: s.id,
      name: s.name,
      movieCount: s._count.movies,
    })),
  });
}
