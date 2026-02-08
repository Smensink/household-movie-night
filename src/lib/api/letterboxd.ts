import { prisma } from "../prisma";
import {
  extractRatingsFromOMDB,
  getHighResPosterUrl,
  getOMDBMovie,
  searchOMDB,
  type OMDBMovie,
} from "./omdb";
import { syncMovieMetadataFromOMDB } from "../movie-metadata";
import { shouldRetrain, trainMatrixFactorization } from "../matrix-factorization";

interface LetterboxdEntry {
  Name: string;
  Year: string;
  "Letterboxd URI"?: string;
  Rating?: string;
  Date?: string;
}

interface CandidateMovie {
  id: string;
  title: string;
  year: number | null;
  imdbId: string | null;
  tmdbId: string | null;
  traktSlug: string | null;
}

export function parseLetterboxdCSV(csvContent: string): LetterboxdEntry[] {
  const lines = csvContent.split("\n");
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]);
  const entries: LetterboxdEntry[] = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseCSVLine(lines[i]);
    const entry: Record<string, string> = {};
    headers.forEach((h, idx) => {
      entry[h] = values[idx] || "";
    });
    entries.push(entry as unknown as LetterboxdEntry);
  }

  return entries;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function parseYear(yearRaw: string | undefined): number | null {
  if (!yearRaw) return null;
  const match = yearRaw.match(/\d{4}/);
  if (!match) return null;
  const value = Number.parseInt(match[0], 10);
  return Number.isNaN(value) ? null : value;
}

function parseLetterboxdRating(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const numeric = Number.parseFloat(trimmed);
  if (!Number.isNaN(numeric)) {
    return Math.max(0.5, Math.min(5, numeric));
  }

  const fullStars = (trimmed.match(/★/g) || []).length;
  const halfStar = trimmed.includes("½") ? 0.5 : 0;
  const parsed = fullStars + halfStar;
  if (parsed <= 0) return null;
  return Math.min(5, parsed);
}

async function findLocalMovieByTitleAndYear(
  title: string,
  year: number | null
): Promise<CandidateMovie | null> {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) return null;

  const exact = await prisma.movie.findFirst({
    where: {
      title: { equals: normalizedTitle, mode: "insensitive" },
      ...(year !== null ? { year } : {}),
    },
    select: {
      id: true,
      title: true,
      year: true,
      imdbId: true,
      tmdbId: true,
      traktSlug: true,
    },
  });
  if (exact) return exact;

  if (year !== null) {
    const nearby = await prisma.movie.findMany({
      where: {
        title: { equals: normalizedTitle, mode: "insensitive" },
        OR: [{ year: year - 1 }, { year: year + 1 }, { year: null }],
      },
      select: {
        id: true,
        title: true,
        year: true,
        imdbId: true,
        tmdbId: true,
        traktSlug: true,
      },
      take: 5,
    });

    if (nearby.length > 0) {
      nearby.sort((a, b) => {
        const score = (movie: CandidateMovie) => {
          let total = 0;
          if (movie.year === year) total += 10;
          else if (movie.year !== null && Math.abs(movie.year - year) === 1) total += 5;
          if (movie.imdbId || movie.tmdbId || movie.traktSlug) total += 3;
          return total;
        };
        return score(b) - score(a);
      });
      return nearby[0];
    }
  }

  const fallback = await prisma.movie.findFirst({
    where: {
      title: { equals: normalizedTitle, mode: "insensitive" },
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      year: true,
      imdbId: true,
      tmdbId: true,
      traktSlug: true,
    },
  });

  return fallback;
}

function parseOmdbYear(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/\d{4}/);
  if (!match) return null;
  const year = Number.parseInt(match[0], 10);
  return Number.isNaN(year) ? null : year;
}

async function findOMDBDetailsForEntry(
  title: string,
  year: number | null
): Promise<OMDBMovie | null> {
  const results = await searchOMDB(title);
  if (results.length === 0) return null;

  const scored = results
    .map((result) => {
      const resultYear = parseOmdbYear(result.Year);
      let score = 0;
      if (year !== null && resultYear !== null) {
        if (resultYear === year) score += 20;
        else if (Math.abs(resultYear - year) === 1) score += 12;
        else score -= 5;
      }

      if (result.Title?.trim().toLowerCase() === title.trim().toLowerCase()) {
        score += 8;
      }

      if (result.imdbID) score += 3;

      return { result, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0]?.result;
  if (!best?.imdbID) return null;

  return getOMDBMovie(best.imdbID);
}

async function upsertMovieFromOMDB(details: OMDBMovie): Promise<CandidateMovie> {
  const parsedYear = parseOmdbYear(details.Year);
  const ratings = extractRatingsFromOMDB(details);

  const movie = await prisma.movie.upsert({
    where: { imdbId: details.imdbID },
    create: {
      imdbId: details.imdbID,
      title: details.Title,
      year: parsedYear,
      posterUrl: getHighResPosterUrl(details.Poster),
      overview: details.Plot && details.Plot !== "N/A" ? details.Plot : null,
      runtime: details.Runtime ? Number.parseInt(details.Runtime, 10) || null : null,
      imdbRating: ratings.imdbRating,
      imdbVotes: ratings.imdbVotes,
      rottenTomatoesAudience: ratings.rottenTomatoesAudience,
    },
    update: {
      title: details.Title,
      ...(parsedYear !== null ? { year: parsedYear } : {}),
      ...(details.Poster && details.Poster !== "N/A"
        ? { posterUrl: getHighResPosterUrl(details.Poster) }
        : {}),
      ...(details.Plot && details.Plot !== "N/A" ? { overview: details.Plot } : {}),
      ...(details.Runtime
        ? { runtime: Number.parseInt(details.Runtime, 10) || undefined }
        : {}),
      ...(ratings.imdbRating !== null ? { imdbRating: ratings.imdbRating } : {}),
      ...(ratings.imdbVotes !== null ? { imdbVotes: ratings.imdbVotes } : {}),
      ...(ratings.rottenTomatoesAudience !== null
        ? { rottenTomatoesAudience: ratings.rottenTomatoesAudience }
        : {}),
    },
    select: {
      id: true,
      title: true,
      year: true,
      imdbId: true,
      tmdbId: true,
      traktSlug: true,
    },
  });

  return movie;
}

async function maybeRetrainModelAfterImport() {
  try {
    const shouldTrain = await shouldRetrain();
    if (!shouldTrain) return;
    await trainMatrixFactorization();
  } catch {
    // Ignore training failures here; import should still succeed.
  }
}

export async function importLetterboxdData(
  userId: string,
  csvContent: string,
  importId: string
) {
  const entries = parseLetterboxdCSV(csvContent);

  await prisma.letterboxdImport.update({
    where: { id: importId },
    data: { total: entries.length, status: "processing" },
  });

  let imported = 0;

  for (const entry of entries) {
    try {
      const parsedYear = parseYear(entry.Year);

      let movie = await findLocalMovieByTitleAndYear(entry.Name, parsedYear);

      if (!movie) {
        const omdbDetails = await findOMDBDetailsForEntry(entry.Name, parsedYear);
        if (omdbDetails) {
          movie = await upsertMovieFromOMDB(omdbDetails);
          await syncMovieMetadataFromOMDB(movie.id, omdbDetails).catch(() => undefined);
        }
      }

      if (!movie) {
        movie = await prisma.movie.create({
          data: {
            title: entry.Name,
            year: parsedYear,
          },
          select: {
            id: true,
            title: true,
            year: true,
            imdbId: true,
            tmdbId: true,
            traktSlug: true,
          },
        });
      }

      // Enrich existing local movie if it doesn't have an external ID yet.
      if (!movie.imdbId) {
        const details = await findOMDBDetailsForEntry(movie.title, movie.year);
        if (details) {
          const enriched = await upsertMovieFromOMDB(details);
          movie = enriched;
          await syncMovieMetadataFromOMDB(movie.id, details).catch(() => undefined);
        }
      }

      const rating = parseLetterboxdRating(entry.Rating);
      await prisma.movieRating.upsert({
        where: { userId_movieId: { userId, movieId: movie.id } },
        create: {
          userId,
          movieId: movie.id,
          rating,
          hasSeen: true,
        },
        update: {
          rating: rating ?? undefined,
          hasSeen: true,
          notHeardOf: false,
        },
      });

      imported++;
      if (imported % 10 === 0) {
        await prisma.letterboxdImport.update({
          where: { id: importId },
          data: { imported },
        });
      }
    } catch {
      // Skip entries that fail.
    }
  }

  await prisma.letterboxdImport.update({
    where: { id: importId },
    data: { imported, status: "complete" },
  });

  void maybeRetrainModelAfterImport();

  return imported;
}
