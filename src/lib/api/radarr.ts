import { prisma } from "../prisma";

async function getRadarrConfig() {
  const config = await prisma.integrationConfig.findUnique({
    where: { service: "radarr" },
  });
  if (!config?.enabled || !config.baseUrl || !config.apiKey) return null;
  return { baseUrl: config.baseUrl.replace(/\/$/, ""), apiKey: config.apiKey };
}

export async function getRadarrMovies() {
  const config = await getRadarrConfig();
  if (!config) return [];

  const res = await fetch(`${config.baseUrl}/api/v3/movie`, {
    headers: { "X-Api-Key": config.apiKey },
  });
  if (!res.ok) return [];
  return res.json();
}

export async function addToRadarr(tmdbId: string, title: string) {
  const config = await getRadarrConfig();
  if (!config) return null;

  // Get root folder
  const foldersRes = await fetch(`${config.baseUrl}/api/v3/rootfolder`, {
    headers: { "X-Api-Key": config.apiKey },
  });
  const folders = await foldersRes.json();
  const rootFolder = folders[0]?.path || "/movies";

  // Get quality profile
  const profilesRes = await fetch(`${config.baseUrl}/api/v3/qualityprofile`, {
    headers: { "X-Api-Key": config.apiKey },
  });
  const profiles = await profilesRes.json();
  const qualityProfileId = profiles[0]?.id || 1;

  const res = await fetch(`${config.baseUrl}/api/v3/movie`, {
    method: "POST",
    headers: {
      "X-Api-Key": config.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title,
      tmdbId: parseInt(tmdbId),
      qualityProfileId,
      rootFolderPath: rootFolder,
      monitored: true,
      addOptions: { searchForMovie: true },
    }),
  });

  if (!res.ok) return null;
  return res.json();
}

export async function checkRadarrAvailability(tmdbId: string) {
  const config = await getRadarrConfig();
  if (!config) return { available: false, monitored: false };

  const res = await fetch(
    `${config.baseUrl}/api/v3/movie?tmdbId=${tmdbId}`,
    { headers: { "X-Api-Key": config.apiKey } }
  );
  if (!res.ok) return { available: false, monitored: false };

  const movies = await res.json();
  if (movies.length === 0) return { available: false, monitored: false };

  return {
    available: movies[0].hasFile || false,
    monitored: movies[0].monitored || false,
    radarrId: movies[0].id,
  };
}
