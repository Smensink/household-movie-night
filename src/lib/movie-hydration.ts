import { prisma } from "@/lib/prisma";
import { getOMDBMovie, extractRatingsFromOMDB, getHighResPosterUrl } from "@/lib/api/omdb";
import {
  getTMDBMovie,
  getTMDBMovieByImdbId,
  getTMDBPosterUrl,
} from "@/lib/api/tmdb";
import { syncMovieMetadataFromOMDB, syncMovieMetadataFromTMDB } from "@/lib/movie-metadata";

function parseOptionalInt(value: string | undefined): number | null {
  if (!value || value === "N/A") return null;
  const match = value.match(/\d+/);
  if (!match) return null;
  const parsed = Number.parseInt(match[0], 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseDateOrNull(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getEra(year: number | null): string | null {
  if (!year) return null;
  const currentYear = new Date().getFullYear();
  if (year >= currentYear - 1) return "new_release";
  if (year >= 2000) return "modern_classic";
  return "classic";
}

async function hasAnyRelations(movieId: string): Promise<boolean> {
  const [castCount, crewCount, studioCount, genreCount] = await Promise.all([
    prisma.movieCast.count({ where: { movieId } }),
    prisma.movieCrew.count({ where: { movieId, job: "Director" } }),
    prisma.movieStudio.count({ where: { movieId } }),
    prisma.movieGenre.count({ where: { movieId } }),
  ]);
  return castCount > 0 || crewCount > 0 || studioCount > 0 || genreCount > 0;
}

/**
 * Ensure a movie has the metadata needed to render `TinderMovieCard`.
 *
 * This is intentionally "lazy": it only runs for movies we are about to show to a user
 * (especially ML-only catalog rows). It fetches OMDB + TMDB details and persists:
 * - poster/backdrop
 * - overview, runtime, year, releaseDate
 * - cast (top), directors, studios, genres
 * - ratings (IMDB + Rotten Tomatoes), imdbVotes
 */
export async function ensureMovieReadyForTinder(movieId: string): Promise<void> {
  const movie = await prisma.movie.findUnique({
    where: { id: movieId },
    select: {
      id: true,
      imdbId: true,
      tmdbId: true,
      title: true,
      year: true,
      posterUrl: true,
      overview: true,
      runtime: true,
      releaseDate: true,
      voteAverage: true,
      voteCount: true,
      popularity: true,
      imdbRating: true,
      rottenTomatoesAudience: true,
      imdbVotes: true,
      backdropUrl: true,
      originalLanguage: true,
      originCountry: true,
      era: true,
    },
  });

  if (!movie) return;

  const needsRelations = !(await hasAnyRelations(movieId));
  const needsBasics =
    !movie.posterUrl ||
    !movie.overview ||
    !movie.runtime ||
    !movie.year ||
    !movie.originalLanguage ||
    (!movie.imdbRating && !movie.voteAverage);

  // Nothing to do.
  if (!needsRelations && !needsBasics) return;

  // Prefer OMDB for plot + ratings + high-res amazon posters.
  if (movie.imdbId) {
    const details = await getOMDBMovie(movie.imdbId);
    if (details) {
      const ratings = extractRatingsFromOMDB(details);
      const omdbYear = parseOptionalInt(details.Year);
      const omdbRuntime = parseOptionalInt(details.Runtime);
      const posterUrl = getHighResPosterUrl(details.Poster) || undefined;

      await prisma.movie.update({
        where: { id: movieId },
        data: {
          ...(posterUrl ? { posterUrl } : {}),
          ...(details.Plot && details.Plot !== "N/A" ? { overview: details.Plot } : {}),
          ...(omdbYear ? { year: omdbYear, era: getEra(omdbYear) } : {}),
          ...(omdbRuntime ? { runtime: omdbRuntime } : {}),
          ...(details.Language && details.Language !== "N/A"
            ? { originalLanguage: details.Language.split(",")[0].trim().toLowerCase() }
            : {}),
          ...(details.Country && details.Country !== "N/A"
            ? { originCountry: details.Country.split(",")[0].trim() }
            : {}),
          ...(ratings.imdbRating != null ? { imdbRating: ratings.imdbRating } : {}),
          ...(ratings.rottenTomatoesAudience != null
            ? { rottenTomatoesAudience: ratings.rottenTomatoesAudience }
            : {}),
          ...(ratings.imdbVotes != null ? { imdbVotes: ratings.imdbVotes } : {}),
          // Keep existing TMDB voteAverage if present; otherwise use IMDB rating scale-compatible fallback.
        },
      });

      // Cast/crew/studios/genres from OMDB (string lists).
      await syncMovieMetadataFromOMDB(movieId, details).catch(() => undefined);
    }
  }

  // Refresh critical fields so TMDB doesn't override better OMDB-derived values.
  const afterOmdb = await prisma.movie.findUnique({
    where: { id: movieId },
    select: {
      posterUrl: true,
      overview: true,
      runtime: true,
      year: true,
      releaseDate: true,
      backdropUrl: true,
      originalLanguage: true,
      originCountry: true,
    },
  });

  // TMDB for cast/crew photos, production companies, release date, vote counts, backdrop.
  const tmdbMovie =
    movie.tmdbId ? await getTMDBMovie(movie.tmdbId) : movie.imdbId ? await getTMDBMovieByImdbId(movie.imdbId) : null;

  if (tmdbMovie) {
    const tmdbPosterUrl = tmdbMovie.poster_path
      ? getTMDBPosterUrl(tmdbMovie.poster_path, "w780")
      : null;
    const tmdbBackdropUrl = tmdbMovie.backdrop_path
      ? `https://image.tmdb.org/t/p/w1280${tmdbMovie.backdrop_path}`
      : null;
    const tmdbReleaseDate = parseDateOrNull(tmdbMovie.release_date);
    const tmdbReleaseYear = tmdbMovie.release_date
      ? Number.parseInt(tmdbMovie.release_date.slice(0, 4), 10)
      : null;

    await prisma.movie.update({
      where: { id: movieId },
      data: {
        ...(tmdbMovie.id && !movie.tmdbId ? { tmdbId: String(tmdbMovie.id) } : {}),
        ...(tmdbPosterUrl && !afterOmdb?.posterUrl ? { posterUrl: tmdbPosterUrl } : {}),
        ...(tmdbBackdropUrl && !afterOmdb?.backdropUrl ? { backdropUrl: tmdbBackdropUrl } : {}),
        ...(tmdbMovie.overview && tmdbMovie.overview.trim() && !afterOmdb?.overview
          ? { overview: tmdbMovie.overview.trim() }
          : {}),
        ...(tmdbMovie.runtime && !afterOmdb?.runtime ? { runtime: tmdbMovie.runtime } : {}),
        ...(tmdbReleaseDate && !afterOmdb?.releaseDate ? { releaseDate: tmdbReleaseDate } : {}),
        ...(tmdbReleaseYear && !Number.isNaN(tmdbReleaseYear) && !afterOmdb?.year
          ? { year: tmdbReleaseYear, era: getEra(tmdbReleaseYear) }
          : {}),
        ...(tmdbMovie.vote_average != null ? { voteAverage: tmdbMovie.vote_average } : {}),
        ...(tmdbMovie.vote_count != null ? { voteCount: tmdbMovie.vote_count } : {}),
        ...(tmdbMovie.popularity != null ? { popularity: tmdbMovie.popularity } : {}),
        ...(tmdbMovie.original_language && !afterOmdb?.originalLanguage
          ? { originalLanguage: tmdbMovie.original_language }
          : {}),
        ...(tmdbMovie.origin_country?.[0] && !afterOmdb?.originCountry
          ? { originCountry: tmdbMovie.origin_country[0] }
          : {}),
      },
    });

    await syncMovieMetadataFromTMDB(movieId, tmdbMovie).catch(() => undefined);
  }
}
