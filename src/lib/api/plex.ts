import { prisma } from "../prisma";

async function getPlexConfig() {
  const config = await prisma.integrationConfig.findUnique({
    where: { service: "plex" },
  });
  if (!config?.enabled || !config.baseUrl || !config.apiKey) return null;
  return { baseUrl: config.baseUrl.replace(/\/$/, ""), token: config.apiKey };
}

export async function searchPlexLibrary(title: string, year?: number) {
  const config = await getPlexConfig();
  if (!config) return [];

  let url = `${config.baseUrl}/search?type=1&query=${encodeURIComponent(title)}`;
  if (year) url += `&year=${year}`;

  const res = await fetch(url, {
    headers: {
      "X-Plex-Token": config.token,
      Accept: "application/json",
    },
  });
  if (!res.ok) return [];

  const data = await res.json();
  return data.MediaContainer?.Metadata || [];
}

export async function getPlexLibraryMovies(sectionId = "1") {
  const config = await getPlexConfig();
  if (!config) return [];

  const res = await fetch(
    `${config.baseUrl}/library/sections/${sectionId}/all?type=1`,
    {
      headers: {
        "X-Plex-Token": config.token,
        Accept: "application/json",
      },
    }
  );
  if (!res.ok) return [];

  const data = await res.json();
  return data.MediaContainer?.Metadata || [];
}

export async function checkPlexAvailability(title: string, year?: number) {
  const results = await searchPlexLibrary(title, year);
  return results.length > 0;
}
