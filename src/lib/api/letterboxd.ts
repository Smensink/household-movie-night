import { prisma } from "../prisma";

interface LetterboxdEntry {
  Name: string;
  Year: string;
  "Letterboxd URI"?: string;
  Rating?: string;
  Date?: string;
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
      // Find or create movie
      let movie = await prisma.movie.findFirst({
        where: {
          title: entry.Name,
          year: entry.Year ? parseInt(entry.Year) : undefined,
        },
      });

      if (!movie) {
        movie = await prisma.movie.create({
          data: {
            title: entry.Name,
            year: entry.Year ? parseInt(entry.Year) : null,
          },
        });
      }

      // Create rating
      const rating = entry.Rating ? parseFloat(entry.Rating) : null;
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
      // Skip entries that fail
    }
  }

  await prisma.letterboxdImport.update({
    where: { id: importId },
    data: { imported, status: "complete" },
  });

  return imported;
}
