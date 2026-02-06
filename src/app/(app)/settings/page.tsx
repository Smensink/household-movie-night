"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Input from "@/components/ui/Input";
import Button from "@/components/ui/Button";

interface Integration {
  id?: string;
  service: string;
  baseUrl: string | null;
  apiKey: string | null;
  enabled: boolean;
}

interface UserSettingsData {
  explorationFactor: number;
  discoverySourcePref: string;
  isAdmin: boolean;
}

interface AlgorithmSettings {
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

const DEFAULT_ALGORITHM_SETTINGS: AlgorithmSettings = {
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

interface SliderProps {
  label: string;
  description: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}

function formatSliderValue(value: number, step: number): string {
  const decimals = step < 1 ? Math.max(1, String(step).split(".")[1]?.length || 0) : 0;
  return value.toFixed(decimals);
}

function SliderRow({
  label,
  description,
  min,
  max,
  step,
  value,
  onChange,
}: SliderProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label className="text-xs font-medium text-foreground">{label}</label>
        <span className="text-[11px] text-accent font-semibold">
          {formatSliderValue(value, step)}
        </span>
      </div>
      <p className="text-[11px] text-muted">{description}</p>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(parseFloat(event.target.value))}
        className="w-full h-1.5 bg-border rounded-lg appearance-none cursor-pointer accent-accent"
      />
    </div>
  );
}

export default function SettingsPage() {
  const { status } = useSession();
  const router = useRouter();
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [letterboxdFile, setLetterboxdFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [userSettings, setUserSettings] = useState<UserSettingsData>({
    explorationFactor: 0.5,
    discoverySourcePref: "balanced",
    isAdmin: false,
  });
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [algorithmSettings, setAlgorithmSettings] = useState<AlgorithmSettings>(
    DEFAULT_ALGORITHM_SETTINGS
  );
  const [algorithmSaved, setAlgorithmSaved] = useState(false);
  const [algorithmSaving, setAlgorithmSaving] = useState(false);

  const [forms, setForms] = useState<
    Record<string, { baseUrl: string; apiKey: string }>
  >({
    radarr: { baseUrl: "", apiKey: "" },
    plex: { baseUrl: "", apiKey: "" },
    trakt: { baseUrl: "", apiKey: "" },
    omdb: { baseUrl: "", apiKey: "" },
  });

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  useEffect(() => {
    if (status !== "authenticated") return;

    Promise.all([
      fetch("/api/integrations")
        .then((response) => (response.ok ? response.json() : []))
        .catch(() => []),
      fetch("/api/settings").then((response) => response.json()),
      fetch("/api/settings/algorithm")
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null),
    ]).then(([integrationData, userSettingsData, algorithmData]) => {
      if (Array.isArray(integrationData)) {
        setIntegrations(integrationData);
        for (const integration of integrationData) {
          setForms((prev) => ({
            ...prev,
            [integration.service]: {
              baseUrl: integration.baseUrl || "",
              apiKey: "",
            },
          }));
        }
      }

      if (userSettingsData && !userSettingsData.error) {
        setUserSettings(userSettingsData);
      }

      if (algorithmData && typeof algorithmData === "object") {
        setAlgorithmSettings(algorithmData as AlgorithmSettings);
      }
    });
  }, [status]);

  const saveIntegration = async (service: string) => {
    setSaving(service);
    const form = forms[service];

    await fetch("/api/integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service,
        baseUrl: form.baseUrl || null,
        apiKey: form.apiKey || undefined,
        enabled: true,
      }),
    });

    setSaving(null);
    setSaved(service);
    setTimeout(() => setSaved(null), 2000);
  };

  const saveUserSettings = async () => {
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        explorationFactor: userSettings.explorationFactor,
        discoverySourcePref: userSettings.discoverySourcePref,
      }),
    });
    setSettingsSaved(true);
    setTimeout(() => setSettingsSaved(false), 2000);
  };

  const saveAlgorithmTuning = async () => {
    setAlgorithmSaving(true);
    const response = await fetch("/api/settings/algorithm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(algorithmSettings),
    });

    if (response.ok) {
      const savedSettings = await response.json();
      setAlgorithmSettings(savedSettings);
      setAlgorithmSaved(true);
      setTimeout(() => setAlgorithmSaved(false), 2000);
    }

    setAlgorithmSaving(false);
  };

  const resetAlgorithmTuning = async () => {
    setAlgorithmSaving(true);
    const response = await fetch("/api/settings/algorithm", {
      method: "DELETE",
    });

    if (response.ok) {
      const resetSettings = await response.json();
      setAlgorithmSettings(resetSettings);
      setAlgorithmSaved(true);
      setTimeout(() => setAlgorithmSaved(false), 2000);
    }

    setAlgorithmSaving(false);
  };

  const handleLetterboxdImport = async () => {
    if (!letterboxdFile) return;
    setImporting(true);

    const formData = new FormData();
    formData.append("file", letterboxdFile);

    const res = await fetch("/api/letterboxd", {
      method: "POST",
      body: formData,
    });

    if (res.ok) {
      setImportStatus("Import started! Processing in background...");
    } else {
      setImportStatus("Import failed. Please try again.");
    }
    setImporting(false);
  };

  const integrationConfigs = [
    {
      service: "radarr",
      name: "Radarr",
      desc: "Monitor and download movies. Strong consensus movies will be auto-added.",
      hasUrl: true,
    },
    {
      service: "plex",
      name: "Plex",
      desc: "Check what movies are already available on your server.",
      hasUrl: true,
    },
    {
      service: "trakt",
      name: "Trakt",
      desc: "Discover trending, popular, and box office movies. Use Client ID as API key.",
      hasUrl: false,
    },
    {
      service: "omdb",
      name: "OMDB",
      desc: "Get movie details, posters, and metadata.",
      hasUrl: false,
    },
  ];

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-muted mt-1">
          Configure preferences, integrations, imports, and recommendation behavior.
        </p>
      </div>

      <div className="bg-card border border-border rounded-xl p-4 space-y-4">
        <div>
          <h3 className="text-sm font-semibold">Discovery Preferences</h3>
          <p className="text-[11px] text-muted mt-0.5">
            Control how strongly suggestions favor known taste vs new discovery.
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-muted">Familiar favorites</span>
            <span className="text-xs text-muted">New discoveries</span>
          </div>
          <input
            type="range"
            min="0"
            max="1"
            step="0.1"
            value={userSettings.explorationFactor}
            onChange={(e) =>
              setUserSettings((prev) => ({
                ...prev,
                explorationFactor: parseFloat(e.target.value),
              }))
            }
            className="w-full h-2 bg-border rounded-lg appearance-none cursor-pointer accent-accent"
          />
          <div className="text-center mt-1">
            <span className="text-xs font-medium text-accent">
              {userSettings.explorationFactor <= 0.3
                ? "Deep dive into your taste"
                : userSettings.explorationFactor <= 0.7
                ? "Balanced mix"
                : "Maximum exploration"}
            </span>
          </div>
        </div>

        <div>
          <label className="text-xs font-medium text-foreground/80 mb-1.5 block">
            Preferred discovery source
          </label>
          <div className="grid grid-cols-2 gap-2">
            {[
              { value: "balanced", label: "Balanced" },
              { value: "trending", label: "Trending" },
              { value: "popular", label: "Popular" },
              { value: "top_rated", label: "Top Rated" },
              { value: "new_releases", label: "New Releases" },
            ].map((option) => (
              <button
                key={option.value}
                onClick={() =>
                  setUserSettings((prev) => ({
                    ...prev,
                    discoverySourcePref: option.value,
                  }))
                }
                className={`text-xs p-2 rounded-lg border transition-all ${
                  userSettings.discoverySourcePref === option.value
                    ? "border-accent bg-accent/5 text-accent font-medium"
                    : "border-border bg-card-hover text-muted"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={saveUserSettings}>
            Save Preferences
          </Button>
          {settingsSaved && (
            <span className="text-xs text-success animate-slide-up">Saved!</span>
          )}
        </div>
      </div>

      {userSettings.isAdmin && (
        <div className="bg-card border border-border rounded-xl p-4 space-y-5">
          <div>
            <h3 className="text-sm font-semibold">Algorithm Tuning (Admin)</h3>
            <p className="text-[11px] text-muted mt-0.5">
              These values are score multipliers, not direct sampling probabilities. Higher values increase that signal&apos;s influence in ranking.
            </p>
          </div>

          <div className="space-y-4">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Movie Discovery</h4>
            <SliderRow
              label="Preference Weight"
              description="How strongly existing household preferences (genres, people, studios, prior movie ratings) influence movie ranking."
              min={0}
              max={3}
              step={0.05}
              value={algorithmSettings.movieDiscovery.preferenceWeight}
              onChange={(value) =>
                setAlgorithmSettings((prev) => ({
                  ...prev,
                  movieDiscovery: { ...prev.movieDiscovery, preferenceWeight: value },
                }))
              }
            />
            <SliderRow
              label="Discovery Weight"
              description="How strongly novelty, quality, and source signals influence movie ranking."
              min={0}
              max={3}
              step={0.05}
              value={algorithmSettings.movieDiscovery.discoveryWeight}
              onChange={(value) =>
                setAlgorithmSettings((prev) => ({
                  ...prev,
                  movieDiscovery: { ...prev.movieDiscovery, discoveryWeight: value },
                }))
              }
            />
            <SliderRow
              label="Novelty Influence"
              description="Weight for surfacing cast/director/studio combinations the user has rated less often."
              min={0}
              max={2}
              step={0.05}
              value={algorithmSettings.movieDiscovery.noveltyInfluence}
              onChange={(value) =>
                setAlgorithmSettings((prev) => ({
                  ...prev,
                  movieDiscovery: { ...prev.movieDiscovery, noveltyInfluence: value },
                }))
              }
            />
            <SliderRow
              label="Quality Influence"
              description="Weight for movie quality/popularity signals (vote average and popularity)."
              min={0}
              max={2}
              step={0.05}
              value={algorithmSettings.movieDiscovery.qualityInfluence}
              onChange={(value) =>
                setAlgorithmSettings((prev) => ({
                  ...prev,
                  movieDiscovery: { ...prev.movieDiscovery, qualityInfluence: value },
                }))
              }
            />
            <SliderRow
              label="Source Influence"
              description="Weight for source preference alignment (trending/popular/box office/library)."
              min={0}
              max={2}
              step={0.05}
              value={algorithmSettings.movieDiscovery.sourceInfluence}
              onChange={(value) =>
                setAlgorithmSettings((prev) => ({
                  ...prev,
                  movieDiscovery: { ...prev.movieDiscovery, sourceInfluence: value },
                }))
              }
            />
            <SliderRow
              label="Availability Bonus"
              description="Extra score added when a movie is already available in Radarr or Plex."
              min={-1}
              max={1}
              step={0.01}
              value={algorithmSettings.movieDiscovery.availabilityBonus}
              onChange={(value) =>
                setAlgorithmSettings((prev) => ({
                  ...prev,
                  movieDiscovery: { ...prev.movieDiscovery, availabilityBonus: value },
                }))
              }
            />
            <SliderRow
              label="Dislike Penalty"
              description="Penalty applied per strong household dislike (rating 2 or below). More negative means stronger suppression."
              min={-1}
              max={0}
              step={0.01}
              value={algorithmSettings.movieDiscovery.dislikePenalty}
              onChange={(value) =>
                setAlgorithmSettings((prev) => ({
                  ...prev,
                  movieDiscovery: { ...prev.movieDiscovery, dislikePenalty: value },
                }))
              }
            />
            <SliderRow
              label="Random Jitter"
              description="Small random tie-breaker in movie ranking. Higher values increase variety run-to-run."
              min={0}
              max={1}
              step={0.01}
              value={algorithmSettings.movieDiscovery.randomJitter}
              onChange={(value) =>
                setAlgorithmSettings((prev) => ({
                  ...prev,
                  movieDiscovery: { ...prev.movieDiscovery, randomJitter: value },
                }))
              }
            />
          </div>

          <div className="space-y-4">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">People Discovery (Actors/Directors)</h4>
            <SliderRow
              label="Preference Weight"
              description="How strongly known people-affinity and related movie affinity affect actor/director ranking."
              min={0}
              max={3}
              step={0.05}
              value={algorithmSettings.peopleDiscovery.preferenceWeight}
              onChange={(value) =>
                setAlgorithmSettings((prev) => ({
                  ...prev,
                  peopleDiscovery: { ...prev.peopleDiscovery, preferenceWeight: value },
                }))
              }
            />
            <SliderRow
              label="Discovery Weight"
              description="How strongly freshness/prominence signals affect actor/director ranking."
              min={0}
              max={3}
              step={0.05}
              value={algorithmSettings.peopleDiscovery.discoveryWeight}
              onChange={(value) =>
                setAlgorithmSettings((prev) => ({
                  ...prev,
                  peopleDiscovery: { ...prev.peopleDiscovery, discoveryWeight: value },
                }))
              }
            />
            <SliderRow
              label="Random Jitter"
              description="Random tie-breaker for actor/director suggestions."
              min={0}
              max={1}
              step={0.01}
              value={algorithmSettings.peopleDiscovery.randomJitter}
              onChange={(value) =>
                setAlgorithmSettings((prev) => ({
                  ...prev,
                  peopleDiscovery: { ...prev.peopleDiscovery, randomJitter: value },
                }))
              }
            />
          </div>

          <div className="space-y-4">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Studio Discovery</h4>
            <SliderRow
              label="Preference Weight"
              description="How strongly known studio affinity and related movie affinity affect studio ranking."
              min={0}
              max={3}
              step={0.05}
              value={algorithmSettings.studioDiscovery.preferenceWeight}
              onChange={(value) =>
                setAlgorithmSettings((prev) => ({
                  ...prev,
                  studioDiscovery: { ...prev.studioDiscovery, preferenceWeight: value },
                }))
              }
            />
            <SliderRow
              label="Discovery Weight"
              description="How strongly studio novelty/prominence affects studio ranking."
              min={0}
              max={3}
              step={0.05}
              value={algorithmSettings.studioDiscovery.discoveryWeight}
              onChange={(value) =>
                setAlgorithmSettings((prev) => ({
                  ...prev,
                  studioDiscovery: { ...prev.studioDiscovery, discoveryWeight: value },
                }))
              }
            />
            <SliderRow
              label="Random Jitter"
              description="Random tie-breaker for studio suggestions."
              min={0}
              max={1}
              step={0.01}
              value={algorithmSettings.studioDiscovery.randomJitter}
              onChange={(value) =>
                setAlgorithmSettings((prev) => ({
                  ...prev,
                  studioDiscovery: { ...prev.studioDiscovery, randomJitter: value },
                }))
              }
            />
          </div>

          <div className="space-y-4">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Movie Night Matching</h4>
            <SliderRow
              label="Preference Weight"
              description="How strongly background + tonight preference signals (genre/era/people/studio/movie history) drive ranking."
              min={0}
              max={3}
              step={0.05}
              value={algorithmSettings.sessionRecommendation.preferenceWeight}
              onChange={(value) =>
                setAlgorithmSettings((prev) => ({
                  ...prev,
                  sessionRecommendation: { ...prev.sessionRecommendation, preferenceWeight: value },
                }))
              }
            />
            <SliderRow
              label="Discovery Weight"
              description="How strongly novelty/quality signals drive movie-night ranking."
              min={0}
              max={3}
              step={0.05}
              value={algorithmSettings.sessionRecommendation.discoveryWeight}
              onChange={(value) =>
                setAlgorithmSettings((prev) => ({
                  ...prev,
                  sessionRecommendation: { ...prev.sessionRecommendation, discoveryWeight: value },
                }))
              }
            />
            <SliderRow
              label="Radarr Available Boost"
              description="Bonus when a candidate is already available in Radarr."
              min={-1}
              max={2}
              step={0.01}
              value={algorithmSettings.sessionRecommendation.radarrAvailableBoost}
              onChange={(value) =>
                setAlgorithmSettings((prev) => ({
                  ...prev,
                  sessionRecommendation: { ...prev.sessionRecommendation, radarrAvailableBoost: value },
                }))
              }
            />
            <SliderRow
              label="Radarr Monitored Boost"
              description="Bonus when a candidate is monitored in Radarr (priority over non-monitored)."
              min={-1}
              max={2}
              step={0.01}
              value={algorithmSettings.sessionRecommendation.radarrMonitoredBoost}
              onChange={(value) =>
                setAlgorithmSettings((prev) => ({
                  ...prev,
                  sessionRecommendation: { ...prev.sessionRecommendation, radarrMonitoredBoost: value },
                }))
              }
            />
            <SliderRow
              label="Plex Available Boost"
              description="Bonus when a candidate is directly available on Plex."
              min={-1}
              max={2}
              step={0.01}
              value={algorithmSettings.sessionRecommendation.plexAvailableBoost}
              onChange={(value) =>
                setAlgorithmSettings((prev) => ({
                  ...prev,
                  sessionRecommendation: { ...prev.sessionRecommendation, plexAvailableBoost: value },
                }))
              }
            />
            <SliderRow
              label="Mixed Seen Penalty"
              description="Penalty when some session participants have already seen the movie and others have not."
              min={-1}
              max={0}
              step={0.01}
              value={algorithmSettings.sessionRecommendation.mixedSeenPenalty}
              onChange={(value) =>
                setAlgorithmSettings((prev) => ({
                  ...prev,
                  sessionRecommendation: { ...prev.sessionRecommendation, mixedSeenPenalty: value },
                }))
              }
            />
            <SliderRow
              label="Random Jitter Base"
              description="Base random tie-breaker for movie-night ranking regardless of exploration factor."
              min={0}
              max={1}
              step={0.01}
              value={algorithmSettings.sessionRecommendation.randomJitterBase}
              onChange={(value) =>
                setAlgorithmSettings((prev) => ({
                  ...prev,
                  sessionRecommendation: { ...prev.sessionRecommendation, randomJitterBase: value },
                }))
              }
            />
            <SliderRow
              label="Random Jitter Exploration"
              description="Additional random tie-breaker scaled by session exploration factor."
              min={0}
              max={1}
              step={0.01}
              value={algorithmSettings.sessionRecommendation.randomJitterExploration}
              onChange={(value) =>
                setAlgorithmSettings((prev) => ({
                  ...prev,
                  sessionRecommendation: { ...prev.sessionRecommendation, randomJitterExploration: value },
                }))
              }
            />
          </div>

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={saveAlgorithmTuning} loading={algorithmSaving}>
              Save Algorithm Tuning
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={resetAlgorithmTuning}
              loading={algorithmSaving}
            >
              Reset Defaults
            </Button>
            {algorithmSaved && (
              <span className="text-xs text-success animate-slide-up">Saved!</span>
            )}
          </div>
        </div>
      )}

      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Letterboxd Import</h3>
          <p className="text-[11px] text-muted mt-0.5">
            Export your data from Letterboxd and upload the ratings CSV.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <label className="flex-1">
            <input
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => setLetterboxdFile(e.target.files?.[0] || null)}
            />
            <div className="bg-card-hover border border-border rounded-lg px-3 py-2 text-sm text-muted cursor-pointer hover:border-accent/30 transition-all truncate">
              {letterboxdFile ? letterboxdFile.name : "Choose CSV file..."}
            </div>
          </label>
          <Button
            size="sm"
            onClick={handleLetterboxdImport}
            loading={importing}
            disabled={!letterboxdFile}
          >
            Import
          </Button>
        </div>

        {importStatus && (
          <p className="text-xs text-success animate-slide-up">{importStatus}</p>
        )}
      </div>

      {userSettings.isAdmin && (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Integrations</h2>
            <p className="text-[11px] text-muted">
              Admin only. Configure API connections for your household.
            </p>
          </div>

          {integrationConfigs.map((config) => {
            const existing = integrations.find((integration) => integration.service === config.service);
            const form = forms[config.service] || { baseUrl: "", apiKey: "" };

            return (
              <div
                key={config.service}
                className="bg-card border border-border rounded-xl p-4 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold">{config.name}</h3>
                    <p className="text-[11px] text-muted mt-0.5">{config.desc}</p>
                  </div>
                  {existing?.enabled && (
                    <span className="text-[10px] bg-success/15 text-success px-2 py-0.5 rounded-full font-medium">
                      Connected
                    </span>
                  )}
                </div>

                {config.hasUrl && (
                  <Input
                    placeholder="Server URL (e.g., http://192.168.1.100:7878)"
                    value={form.baseUrl}
                    onChange={(e) =>
                      setForms((prev) => ({
                        ...prev,
                        [config.service]: {
                          ...prev[config.service],
                          baseUrl: e.target.value,
                        },
                      }))
                    }
                  />
                )}

                <Input
                  placeholder="API Key"
                  type="password"
                  value={form.apiKey}
                  onChange={(e) =>
                    setForms((prev) => ({
                      ...prev,
                      [config.service]: {
                        ...prev[config.service],
                        apiKey: e.target.value,
                      },
                    }))
                  }
                />

                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => saveIntegration(config.service)}
                    loading={saving === config.service}
                  >
                    {existing ? "Update" : "Connect"}
                  </Button>
                  {saved === config.service && (
                    <span className="text-xs text-success animate-slide-up">Saved!</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!userSettings.isAdmin && (
        <div className="bg-card border border-border rounded-xl p-4 text-center">
          <p className="text-xs text-muted">
            Integration and algorithm tuning settings are only available to household admins.
          </p>
        </div>
      )}
    </div>
  );
}
