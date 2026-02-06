import { prisma } from "./prisma";

const ALGORITHM_SETTINGS_SERVICE = "algorithm_settings";

export interface AlgorithmSettings {
  movieDiscovery: {
    preferenceWeight: number;
    discoveryWeight: number;
    noveltyInfluence: number;
    qualityInfluence: number;
    sourceInfluence: number;
    availabilityBonus: number;
    dislikePenalty: number;
    randomJitter: number;
  };
  peopleDiscovery: {
    preferenceWeight: number;
    discoveryWeight: number;
    randomJitter: number;
  };
  studioDiscovery: {
    preferenceWeight: number;
    discoveryWeight: number;
    randomJitter: number;
  };
  sessionRecommendation: {
    preferenceWeight: number;
    discoveryWeight: number;
    radarrAvailableBoost: number;
    radarrMonitoredBoost: number;
    plexAvailableBoost: number;
    mixedSeenPenalty: number;
    randomJitterBase: number;
    randomJitterExploration: number;
  };
}

export const DEFAULT_ALGORITHM_SETTINGS: AlgorithmSettings = {
  movieDiscovery: {
    preferenceWeight: 1,
    discoveryWeight: 1,
    noveltyInfluence: 0.45,
    qualityInfluence: 0.2,
    sourceInfluence: 0.35,
    availabilityBonus: 0.05,
    dislikePenalty: -0.08,
    randomJitter: 0.04,
  },
  peopleDiscovery: {
    preferenceWeight: 1,
    discoveryWeight: 1,
    randomJitter: 0.03,
  },
  studioDiscovery: {
    preferenceWeight: 1,
    discoveryWeight: 1,
    randomJitter: 0.03,
  },
  sessionRecommendation: {
    preferenceWeight: 1,
    discoveryWeight: 1,
    radarrAvailableBoost: 0.55,
    radarrMonitoredBoost: 0.25,
    plexAvailableBoost: 0.2,
    mixedSeenPenalty: -0.15,
    randomJitterBase: 0.05,
    randomJitterExploration: 0.05,
  },
};

type PartialAlgorithmSettings = {
  movieDiscovery?: Partial<AlgorithmSettings["movieDiscovery"]>;
  peopleDiscovery?: Partial<AlgorithmSettings["peopleDiscovery"]>;
  studioDiscovery?: Partial<AlgorithmSettings["studioDiscovery"]>;
  sessionRecommendation?: Partial<AlgorithmSettings["sessionRecommendation"]>;
};

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }

  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function sanitizeSettings(raw: unknown): AlgorithmSettings {
  const input: PartialAlgorithmSettings =
    raw && typeof raw === "object"
      ? (raw as PartialAlgorithmSettings)
      : {};

  const movieDiscovery = input.movieDiscovery || {};
  const peopleDiscovery = input.peopleDiscovery || {};
  const studioDiscovery = input.studioDiscovery || {};
  const sessionRecommendation = input.sessionRecommendation || {};

  return {
    movieDiscovery: {
      preferenceWeight: clampNumber(
        movieDiscovery.preferenceWeight,
        0,
        3,
        DEFAULT_ALGORITHM_SETTINGS.movieDiscovery.preferenceWeight
      ),
      discoveryWeight: clampNumber(
        movieDiscovery.discoveryWeight,
        0,
        3,
        DEFAULT_ALGORITHM_SETTINGS.movieDiscovery.discoveryWeight
      ),
      noveltyInfluence: clampNumber(
        movieDiscovery.noveltyInfluence,
        0,
        2,
        DEFAULT_ALGORITHM_SETTINGS.movieDiscovery.noveltyInfluence
      ),
      qualityInfluence: clampNumber(
        movieDiscovery.qualityInfluence,
        0,
        2,
        DEFAULT_ALGORITHM_SETTINGS.movieDiscovery.qualityInfluence
      ),
      sourceInfluence: clampNumber(
        movieDiscovery.sourceInfluence,
        0,
        2,
        DEFAULT_ALGORITHM_SETTINGS.movieDiscovery.sourceInfluence
      ),
      availabilityBonus: clampNumber(
        movieDiscovery.availabilityBonus,
        -1,
        1,
        DEFAULT_ALGORITHM_SETTINGS.movieDiscovery.availabilityBonus
      ),
      dislikePenalty: clampNumber(
        movieDiscovery.dislikePenalty,
        -1,
        0,
        DEFAULT_ALGORITHM_SETTINGS.movieDiscovery.dislikePenalty
      ),
      randomJitter: clampNumber(
        movieDiscovery.randomJitter,
        0,
        1,
        DEFAULT_ALGORITHM_SETTINGS.movieDiscovery.randomJitter
      ),
    },
    peopleDiscovery: {
      preferenceWeight: clampNumber(
        peopleDiscovery.preferenceWeight,
        0,
        3,
        DEFAULT_ALGORITHM_SETTINGS.peopleDiscovery.preferenceWeight
      ),
      discoveryWeight: clampNumber(
        peopleDiscovery.discoveryWeight,
        0,
        3,
        DEFAULT_ALGORITHM_SETTINGS.peopleDiscovery.discoveryWeight
      ),
      randomJitter: clampNumber(
        peopleDiscovery.randomJitter,
        0,
        1,
        DEFAULT_ALGORITHM_SETTINGS.peopleDiscovery.randomJitter
      ),
    },
    studioDiscovery: {
      preferenceWeight: clampNumber(
        studioDiscovery.preferenceWeight,
        0,
        3,
        DEFAULT_ALGORITHM_SETTINGS.studioDiscovery.preferenceWeight
      ),
      discoveryWeight: clampNumber(
        studioDiscovery.discoveryWeight,
        0,
        3,
        DEFAULT_ALGORITHM_SETTINGS.studioDiscovery.discoveryWeight
      ),
      randomJitter: clampNumber(
        studioDiscovery.randomJitter,
        0,
        1,
        DEFAULT_ALGORITHM_SETTINGS.studioDiscovery.randomJitter
      ),
    },
    sessionRecommendation: {
      preferenceWeight: clampNumber(
        sessionRecommendation.preferenceWeight,
        0,
        3,
        DEFAULT_ALGORITHM_SETTINGS.sessionRecommendation.preferenceWeight
      ),
      discoveryWeight: clampNumber(
        sessionRecommendation.discoveryWeight,
        0,
        3,
        DEFAULT_ALGORITHM_SETTINGS.sessionRecommendation.discoveryWeight
      ),
      radarrAvailableBoost: clampNumber(
        sessionRecommendation.radarrAvailableBoost,
        -1,
        2,
        DEFAULT_ALGORITHM_SETTINGS.sessionRecommendation.radarrAvailableBoost
      ),
      radarrMonitoredBoost: clampNumber(
        sessionRecommendation.radarrMonitoredBoost,
        -1,
        2,
        DEFAULT_ALGORITHM_SETTINGS.sessionRecommendation.radarrMonitoredBoost
      ),
      plexAvailableBoost: clampNumber(
        sessionRecommendation.plexAvailableBoost,
        -1,
        2,
        DEFAULT_ALGORITHM_SETTINGS.sessionRecommendation.plexAvailableBoost
      ),
      mixedSeenPenalty: clampNumber(
        sessionRecommendation.mixedSeenPenalty,
        -1,
        0,
        DEFAULT_ALGORITHM_SETTINGS.sessionRecommendation.mixedSeenPenalty
      ),
      randomJitterBase: clampNumber(
        sessionRecommendation.randomJitterBase,
        0,
        1,
        DEFAULT_ALGORITHM_SETTINGS.sessionRecommendation.randomJitterBase
      ),
      randomJitterExploration: clampNumber(
        sessionRecommendation.randomJitterExploration,
        0,
        1,
        DEFAULT_ALGORITHM_SETTINGS.sessionRecommendation.randomJitterExploration
      ),
    },
  };
}

export async function getAlgorithmSettings(): Promise<AlgorithmSettings> {
  const config = await prisma.integrationConfig.findUnique({
    where: { service: ALGORITHM_SETTINGS_SERVICE },
    select: { config: true },
  });

  if (!config?.config) {
    return DEFAULT_ALGORITHM_SETTINGS;
  }

  try {
    const parsed = JSON.parse(config.config);
    return sanitizeSettings(parsed);
  } catch {
    return DEFAULT_ALGORITHM_SETTINGS;
  }
}

export async function saveAlgorithmSettings(
  settings: unknown
): Promise<AlgorithmSettings> {
  const sanitized = sanitizeSettings(settings);

  await prisma.integrationConfig.upsert({
    where: { service: ALGORITHM_SETTINGS_SERVICE },
    create: {
      service: ALGORITHM_SETTINGS_SERVICE,
      enabled: true,
      config: JSON.stringify(sanitized),
    },
    update: {
      enabled: true,
      config: JSON.stringify(sanitized),
    },
  });

  return sanitized;
}
