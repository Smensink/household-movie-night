import { Readable } from "node:stream";
import { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";
import readline from "node:readline";
import { prisma } from "@/lib/prisma";

const V3_VERSION = 3;
const PAGE_SIZE = 250;

export interface BackupV3Options {
  includeEmbeddedAssets: boolean;
}

export interface BackupProgressState {
  inProgress: boolean;
  phase: string;
  current: number;
  total: number;
  startedAt: Date | null;
}

export interface RestoreStats {
  users: number;
  households: number;
  householdMembers: number;
  genres: number;
  studios: number;
  people: number;
  movies: number;
  movieGenres: number;
  movieStudios: number;
  movieCast: number;
  movieCrew: number;
  genreRankings: number;
  movieRatings: number;
  actorRatings: number;
  directorRatings: number;
  studioRatings: number;
  userSettings: number;
  integrationConfigs: number;
  skipped: number;
}

type BackupRecord = {
  type: string;
  payload: Record<string, unknown>;
};

const EMPTY_RESTORE_STATS: RestoreStats = {
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

function stripEmbeddedUrl(url: string | null | undefined, includeEmbeddedAssets: boolean) {
  if (!url) return null;
  if (!includeEmbeddedAssets && url.startsWith("data:")) return null;
  return url;
}

async function* iterateById<T extends { id: string }>(
  loader: (cursor?: string) => Promise<T[]>
) {
  let cursor: string | undefined;
  while (true) {
    const page = await loader(cursor);
    if (!page.length) break;
    for (const row of page) yield row;
    cursor = page[page.length - 1].id;
  }
}

async function* iterateByOffset<T>(loader: (skip: number, take: number) => Promise<T[]>) {
  let skip = 0;
  while (true) {
    const page = await loader(skip, PAGE_SIZE);
    if (!page.length) break;
    for (const row of page) yield row;
    skip += page.length;
  }
}

export function createBackupV3Stream(
  options: BackupV3Options,
  progress: BackupProgressState
) {
  const encoder = new TextEncoder();
  const ndjson = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (type: string, payload: Record<string, unknown>) => {
        const record: BackupRecord = { type, payload };
        controller.enqueue(encoder.encode(JSON.stringify(record) + "\n"));
        progress.current += 1;
      };

      try {
        emit("meta", { version: V3_VERSION, createdAt: new Date().toISOString(), options });
        progress.phase = "Exporting users";

        for await (const row of iterateById((cursor) =>
          prisma.user.findMany({
            select: { id: true, email: true, name: true, passwordHash: true, avatarUrl: true, isGuest: true },
            take: PAGE_SIZE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            orderBy: { id: "asc" },
          })
        )) emit("user", row as unknown as Record<string, unknown>);

        progress.phase = "Exporting households";
        for await (const row of iterateById((cursor) =>
          prisma.household.findMany({
            select: { id: true, name: true, inviteCode: true },
            take: PAGE_SIZE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            orderBy: { id: "asc" },
          })
        )) emit("household", row as unknown as Record<string, unknown>);

        for await (const row of iterateByOffset((skip, take) =>
          prisma.householdMember.findMany({
            select: { userId: true, householdId: true, role: true },
            skip, take, orderBy: [{ userId: "asc" }, { householdId: "asc" }],
          })
        )) emit("householdMember", row as unknown as Record<string, unknown>);

        progress.phase = "Exporting catalog";
        for await (const row of iterateById((cursor) =>
          prisma.genre.findMany({
            select: { id: true, name: true, slug: true },
            take: PAGE_SIZE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            orderBy: { id: "asc" },
          })
        )) emit("genre", row as unknown as Record<string, unknown>);

        for await (const row of iterateById((cursor) =>
          prisma.studio.findMany({
            select: { id: true, name: true, slug: true },
            take: PAGE_SIZE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            orderBy: { id: "asc" },
          })
        )) emit("studio", row as unknown as Record<string, unknown>);

        for await (const row of iterateById((cursor) =>
          prisma.person.findMany({
            select: { id: true, tmdbId: true, name: true, photoUrl: true, knownFor: true },
            take: PAGE_SIZE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            orderBy: { id: "asc" },
          })
        )) {
          emit("person", {
            ...row,
            photoUrl: stripEmbeddedUrl(row.photoUrl, options.includeEmbeddedAssets),
          } as unknown as Record<string, unknown>);
        }

        for await (const row of iterateById((cursor) =>
          prisma.movie.findMany({
            select: {
              id: true, imdbId: true, tmdbId: true, traktSlug: true, title: true, year: true,
              posterUrl: true, backdropUrl: true, overview: true, runtime: true, releaseDate: true,
              certification: true, popularity: true, voteAverage: true, voteCount: true,
              imdbRating: true, imdbVotes: true, rottenTomatoesAudience: true, letterboxdRating: true, era: true,
            },
            take: PAGE_SIZE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            orderBy: { id: "asc" },
          })
        )) {
          emit("movie", {
            ...row,
            releaseDate: row.releaseDate ? row.releaseDate.toISOString() : null,
            posterUrl: stripEmbeddedUrl(row.posterUrl, options.includeEmbeddedAssets),
            backdropUrl: stripEmbeddedUrl(row.backdropUrl, options.includeEmbeddedAssets),
          } as unknown as Record<string, unknown>);
        }

        progress.phase = "Exporting relations";
        for await (const row of iterateByOffset((skip, take) =>
          prisma.movieGenre.findMany({ select: { movieId: true, genreId: true }, skip, take, orderBy: [{ movieId: "asc" }, { genreId: "asc" }] })
        )) emit("movieGenre", row as unknown as Record<string, unknown>);
        for await (const row of iterateByOffset((skip, take) =>
          prisma.movieStudio.findMany({ select: { movieId: true, studioId: true }, skip, take, orderBy: [{ movieId: "asc" }, { studioId: "asc" }] })
        )) emit("movieStudio", row as unknown as Record<string, unknown>);
        for await (const row of iterateByOffset((skip, take) =>
          prisma.movieCast.findMany({ select: { movieId: true, personId: true, character: true, castOrder: true }, skip, take, orderBy: [{ movieId: "asc" }, { personId: "asc" }] })
        )) emit("movieCast", row as unknown as Record<string, unknown>);
        for await (const row of iterateByOffset((skip, take) =>
          prisma.movieCrew.findMany({ select: { movieId: true, personId: true, job: true }, skip, take, orderBy: [{ movieId: "asc" }, { personId: "asc" }, { job: "asc" }] })
        )) emit("movieCrew", row as unknown as Record<string, unknown>);

        progress.phase = "Exporting preferences";
        for await (const row of iterateById((cursor) =>
          prisma.genreRanking.findMany({ select: { id: true, userId: true, genreId: true, rank: true }, take: PAGE_SIZE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), orderBy: { id: "asc" } })
        )) emit("genreRanking", row as unknown as Record<string, unknown>);
        for await (const row of iterateById((cursor) =>
          prisma.movieRating.findMany({ select: { id: true, userId: true, movieId: true, rating: true, hasSeen: true, notHeardOf: true }, take: PAGE_SIZE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), orderBy: { id: "asc" } })
        )) emit("movieRating", row as unknown as Record<string, unknown>);
        for await (const row of iterateById((cursor) =>
          prisma.actorRating.findMany({ select: { id: true, userId: true, personId: true, rating: true, notHeardOf: true }, take: PAGE_SIZE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), orderBy: { id: "asc" } })
        )) emit("actorRating", row as unknown as Record<string, unknown>);
        for await (const row of iterateById((cursor) =>
          prisma.directorRating.findMany({ select: { id: true, userId: true, personId: true, rating: true, notHeardOf: true }, take: PAGE_SIZE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), orderBy: { id: "asc" } })
        )) emit("directorRating", row as unknown as Record<string, unknown>);
        for await (const row of iterateById((cursor) =>
          prisma.studioRating.findMany({ select: { id: true, userId: true, studioId: true, rating: true, notHeardOf: true }, take: PAGE_SIZE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), orderBy: { id: "asc" } })
        )) emit("studioRating", row as unknown as Record<string, unknown>);
        for await (const row of iterateById((cursor) =>
          prisma.userSettings.findMany({ select: { id: true, userId: true, explorationFactor: true, discoverySourcePref: true }, take: PAGE_SIZE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), orderBy: { id: "asc" } })
        )) emit("userSettings", row as unknown as Record<string, unknown>);
        for await (const row of iterateById((cursor) =>
          prisma.integrationConfig.findMany({ select: { id: true, service: true, baseUrl: true, apiKey: true, enabled: true }, take: PAGE_SIZE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), orderBy: { id: "asc" } })
        )) emit("integrationConfig", row as unknown as Record<string, unknown>);

        progress.phase = "Complete";
        progress.inProgress = false;
        controller.close();
      } catch (error) {
        progress.phase = "Error";
        progress.inProgress = false;
        controller.error(error);
      }
    },
  });

  return ndjson.pipeThrough(
    new CompressionStream("gzip") as unknown as TransformStream<
      Uint8Array,
      Uint8Array
    >
  );
}

export async function restoreSetupFromV3Request(req: Request) {
  const stats: RestoreStats = { ...EMPTY_RESTORE_STATS };
  const existingUsers = await prisma.user.count();
  if (existingUsers > 0) throw new Error("Users already exist");
  if (!req.body) throw new Error("Missing request body");

  const contentType = req.headers.get("content-type") || "";
  const isGzip =
    contentType.includes("application/gzip") ||
    contentType.includes("application/x-gzip") ||
    req.headers.get("x-backup-format")?.toLowerCase() === "v3-gzip";

  const input = Readable.fromWeb(req.body as unknown as NodeReadableStream);
  const reader = isGzip ? input.pipe(createGunzip()) : input;
  const rl = readline.createInterface({ input: reader, crlfDelay: Infinity });
  let seenMeta = false;

  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    const record = JSON.parse(line) as BackupRecord;
    const p = record.payload;
    if (record.type === "meta") {
      if (Number(p.version || 0) !== V3_VERSION) throw new Error("Unsupported backup version");
      seenMeta = true;
      continue;
    }
    if (!seenMeta) throw new Error("Invalid backup stream");

    try {
      switch (record.type) {
        case "user":
          await prisma.user.upsert({ where: { id: String(p.id) }, create: { id: String(p.id), email: p.email ? String(p.email) : null, name: String(p.name || ""), passwordHash: p.passwordHash ? String(p.passwordHash) : null, avatarUrl: p.avatarUrl ? String(p.avatarUrl) : null, isGuest: Boolean(p.isGuest) }, update: { email: p.email ? String(p.email) : null, name: String(p.name || ""), passwordHash: p.passwordHash ? String(p.passwordHash) : null, avatarUrl: p.avatarUrl ? String(p.avatarUrl) : null, isGuest: Boolean(p.isGuest) } });
          stats.users++;
          break;
        case "household":
          await prisma.household.upsert({ where: { id: String(p.id) }, create: { id: String(p.id), name: String(p.name || ""), inviteCode: String(p.inviteCode || "") }, update: { name: String(p.name || ""), inviteCode: String(p.inviteCode || "") } });
          stats.households++;
          break;
        case "householdMember":
          await prisma.householdMember.upsert({ where: { userId_householdId: { userId: String(p.userId), householdId: String(p.householdId) } }, create: { userId: String(p.userId), householdId: String(p.householdId), role: String(p.role || "member") }, update: { role: String(p.role || "member") } });
          stats.householdMembers++;
          break;
        case "genre":
          await prisma.genre.upsert({ where: { id: String(p.id) }, create: { id: String(p.id), name: String(p.name || ""), slug: String(p.slug || "") }, update: { name: String(p.name || ""), slug: String(p.slug || "") } });
          stats.genres++;
          break;
        case "studio":
          await prisma.studio.upsert({ where: { id: String(p.id) }, create: { id: String(p.id), name: String(p.name || ""), slug: String(p.slug || "") }, update: { name: String(p.name || ""), slug: String(p.slug || "") } });
          stats.studios++;
          break;
        case "person":
          await prisma.person.upsert({ where: { id: String(p.id) }, create: { id: String(p.id), tmdbId: p.tmdbId ? String(p.tmdbId) : null, name: String(p.name || ""), photoUrl: p.photoUrl ? String(p.photoUrl) : null, knownFor: p.knownFor ? String(p.knownFor) : null }, update: { tmdbId: p.tmdbId ? String(p.tmdbId) : null, name: String(p.name || ""), photoUrl: p.photoUrl ? String(p.photoUrl) : null, knownFor: p.knownFor ? String(p.knownFor) : null } });
          stats.people++;
          break;
        case "movie":
          await prisma.movie.upsert({ where: { id: String(p.id) }, create: { id: String(p.id), imdbId: p.imdbId ? String(p.imdbId) : null, tmdbId: p.tmdbId ? String(p.tmdbId) : null, traktSlug: p.traktSlug ? String(p.traktSlug) : null, title: String(p.title || ""), year: p.year === null ? null : Number(p.year), posterUrl: p.posterUrl ? String(p.posterUrl) : null, backdropUrl: p.backdropUrl ? String(p.backdropUrl) : null, overview: p.overview ? String(p.overview) : null, runtime: p.runtime === null ? null : Number(p.runtime), releaseDate: p.releaseDate ? new Date(String(p.releaseDate)) : null, certification: p.certification ? String(p.certification) : null, popularity: p.popularity === null ? null : Number(p.popularity), voteAverage: p.voteAverage === null ? null : Number(p.voteAverage), voteCount: p.voteCount === null ? null : Number(p.voteCount), imdbRating: p.imdbRating === null ? null : Number(p.imdbRating), imdbVotes: p.imdbVotes === null ? null : Number(p.imdbVotes), rottenTomatoesAudience: p.rottenTomatoesAudience === null ? null : Number(p.rottenTomatoesAudience), letterboxdRating: p.letterboxdRating === null ? null : Number(p.letterboxdRating), era: p.era ? String(p.era) : null }, update: { imdbId: p.imdbId ? String(p.imdbId) : null, tmdbId: p.tmdbId ? String(p.tmdbId) : null, traktSlug: p.traktSlug ? String(p.traktSlug) : null, title: String(p.title || ""), year: p.year === null ? null : Number(p.year), posterUrl: p.posterUrl ? String(p.posterUrl) : null, backdropUrl: p.backdropUrl ? String(p.backdropUrl) : null, overview: p.overview ? String(p.overview) : null, runtime: p.runtime === null ? null : Number(p.runtime), releaseDate: p.releaseDate ? new Date(String(p.releaseDate)) : null, certification: p.certification ? String(p.certification) : null, popularity: p.popularity === null ? null : Number(p.popularity), voteAverage: p.voteAverage === null ? null : Number(p.voteAverage), voteCount: p.voteCount === null ? null : Number(p.voteCount), imdbRating: p.imdbRating === null ? null : Number(p.imdbRating), imdbVotes: p.imdbVotes === null ? null : Number(p.imdbVotes), rottenTomatoesAudience: p.rottenTomatoesAudience === null ? null : Number(p.rottenTomatoesAudience), letterboxdRating: p.letterboxdRating === null ? null : Number(p.letterboxdRating), era: p.era ? String(p.era) : null } });
          stats.movies++;
          break;
        case "movieGenre":
          await prisma.movieGenre.upsert({ where: { movieId_genreId: { movieId: String(p.movieId), genreId: String(p.genreId) } }, create: { movieId: String(p.movieId), genreId: String(p.genreId) }, update: {} });
          stats.movieGenres++;
          break;
        case "movieStudio":
          await prisma.movieStudio.upsert({ where: { movieId_studioId: { movieId: String(p.movieId), studioId: String(p.studioId) } }, create: { movieId: String(p.movieId), studioId: String(p.studioId) }, update: {} });
          stats.movieStudios++;
          break;
        case "movieCast":
          await prisma.movieCast.upsert({ where: { movieId_personId: { movieId: String(p.movieId), personId: String(p.personId) } }, create: { movieId: String(p.movieId), personId: String(p.personId), character: p.character ? String(p.character) : null, castOrder: p.castOrder === null ? null : Number(p.castOrder) }, update: { character: p.character ? String(p.character) : null, castOrder: p.castOrder === null ? null : Number(p.castOrder) } });
          stats.movieCast++;
          break;
        case "movieCrew":
          await prisma.movieCrew.upsert({ where: { movieId_personId_job: { movieId: String(p.movieId), personId: String(p.personId), job: String(p.job || "") } }, create: { movieId: String(p.movieId), personId: String(p.personId), job: String(p.job || "") }, update: {} });
          stats.movieCrew++;
          break;
        case "genreRanking":
          await prisma.genreRanking.upsert({ where: { userId_genreId: { userId: String(p.userId), genreId: String(p.genreId) } }, create: { userId: String(p.userId), genreId: String(p.genreId), rank: Number(p.rank) }, update: { rank: Number(p.rank) } });
          stats.genreRankings++;
          break;
        case "movieRating":
          await prisma.movieRating.upsert({ where: { userId_movieId: { userId: String(p.userId), movieId: String(p.movieId) } }, create: { userId: String(p.userId), movieId: String(p.movieId), rating: p.rating === null ? null : Number(p.rating), hasSeen: Boolean(p.hasSeen), notHeardOf: Boolean(p.notHeardOf) }, update: { rating: p.rating === null ? null : Number(p.rating), hasSeen: Boolean(p.hasSeen), notHeardOf: Boolean(p.notHeardOf) } });
          stats.movieRatings++;
          break;
        case "actorRating":
          await prisma.actorRating.upsert({ where: { userId_personId: { userId: String(p.userId), personId: String(p.personId) } }, create: { userId: String(p.userId), personId: String(p.personId), rating: p.rating === null ? null : Number(p.rating), notHeardOf: Boolean(p.notHeardOf) }, update: { rating: p.rating === null ? null : Number(p.rating), notHeardOf: Boolean(p.notHeardOf) } });
          stats.actorRatings++;
          break;
        case "directorRating":
          await prisma.directorRating.upsert({ where: { userId_personId: { userId: String(p.userId), personId: String(p.personId) } }, create: { userId: String(p.userId), personId: String(p.personId), rating: p.rating === null ? null : Number(p.rating), notHeardOf: Boolean(p.notHeardOf) }, update: { rating: p.rating === null ? null : Number(p.rating), notHeardOf: Boolean(p.notHeardOf) } });
          stats.directorRatings++;
          break;
        case "studioRating":
          await prisma.studioRating.upsert({ where: { userId_studioId: { userId: String(p.userId), studioId: String(p.studioId) } }, create: { userId: String(p.userId), studioId: String(p.studioId), rating: p.rating === null ? null : Number(p.rating), notHeardOf: Boolean(p.notHeardOf) }, update: { rating: p.rating === null ? null : Number(p.rating), notHeardOf: Boolean(p.notHeardOf) } });
          stats.studioRatings++;
          break;
        case "userSettings":
          await prisma.userSettings.upsert({ where: { userId: String(p.userId) }, create: { userId: String(p.userId), explorationFactor: Number(p.explorationFactor || 0.5), discoverySourcePref: String(p.discoverySourcePref || "balanced") }, update: { explorationFactor: Number(p.explorationFactor || 0.5), discoverySourcePref: String(p.discoverySourcePref || "balanced") } });
          stats.userSettings++;
          break;
        case "integrationConfig":
          await prisma.integrationConfig.upsert({ where: { service: String(p.service || "") }, create: { service: String(p.service || ""), baseUrl: p.baseUrl ? String(p.baseUrl) : null, apiKey: p.apiKey ? String(p.apiKey) : null, enabled: Boolean(p.enabled) }, update: { baseUrl: p.baseUrl ? String(p.baseUrl) : null, apiKey: p.apiKey ? String(p.apiKey) : null, enabled: Boolean(p.enabled) } });
          stats.integrationConfigs++;
          break;
        default:
          break;
      }
    } catch {
      stats.skipped++;
    }
  }

  return stats;
}

export const BACKUP_V3_VERSION = V3_VERSION;
