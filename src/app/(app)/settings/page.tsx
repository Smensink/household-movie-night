"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import StarRating from "@/components/StarRating";
import Input from "@/components/ui/Input";
import Button from "@/components/ui/Button";

interface Integration {
  id?: string;
  service: string;
  baseUrl: string | null;
  apiKey: string | null;
  enabled: boolean;
}

interface Studio {
  id: string;
  name: string;
  slug: string;
}

interface UserSettingsData {
  explorationFactor: number;
  discoverySourcePref: string;
  isAdmin: boolean;
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
  const [studios, setStudios] = useState<Studio[]>([]);
  const [studioRatings, setStudioRatings] = useState<
    Record<string, { rating: number | null; notHeardOf: boolean }>
  >({});
  const [settingsSaved, setSettingsSaved] = useState(false);

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

    // Load all settings data
    Promise.all([
      fetch("/api/integrations").then((r) => r.json()),
      fetch("/api/settings").then((r) => r.json()),
      fetch("/api/ratings/studios").then((r) => r.json()),
    ]).then(([intData, settingsData, studioData]) => {
      if (Array.isArray(intData)) {
        setIntegrations(intData);
        for (const i of intData) {
          setForms((prev) => ({
            ...prev,
            [i.service]: { baseUrl: i.baseUrl || "", apiKey: "" },
          }));
        }
      }
      if (settingsData && !settingsData.error) {
        setUserSettings(settingsData);
      }
      if (studioData?.studios) {
        setStudios(studioData.studios);
        setStudioRatings(studioData.ratings || {});
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

  const rateStudio = async (
    studioId: string,
    rating: number | null,
    notHeardOf: boolean = false
  ) => {
    setStudioRatings((prev) => ({
      ...prev,
      [studioId]: { rating, notHeardOf },
    }));

    await fetch("/api/ratings/studios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studioId, rating, notHeardOf }),
    });
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
          Configure your preferences, integrations, and import data
        </p>
      </div>

      {/* Discovery Settings */}
      <div className="bg-card border border-border rounded-xl p-4 space-y-4">
        <div>
          <h3 className="text-sm font-semibold">Discovery Preferences</h3>
          <p className="text-[11px] text-muted mt-0.5">
            Control how movies are recommended to you
          </p>
        </div>

        {/* Exploration vs Deepening slider */}
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

        {/* Discovery source preference */}
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
            ].map((opt) => (
              <button
                key={opt.value}
                onClick={() =>
                  setUserSettings((prev) => ({
                    ...prev,
                    discoverySourcePref: opt.value,
                  }))
                }
                className={`text-xs p-2 rounded-lg border transition-all ${
                  userSettings.discoverySourcePref === opt.value
                    ? "border-accent bg-accent/5 text-accent font-medium"
                    : "border-border bg-card-hover text-muted"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={saveUserSettings}>
            Save Preferences
          </Button>
          {settingsSaved && (
            <span className="text-xs text-success animate-slide-up">
              Saved!
            </span>
          )}
        </div>
      </div>

      {/* Studio Ratings */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Rate Studios</h2>
            <p className="text-[11px] text-muted">
              How much do you enjoy movies from these studios?
            </p>
          </div>
          <Link
            href="/preferences"
            className="text-xs text-accent hover:underline"
          >
            Rate movies
          </Link>
        </div>

        <div className="space-y-2">
          {studios.map((studio) => {
            const r = studioRatings[studio.id];
            return (
              <div
                key={studio.id}
                className="bg-card border border-border rounded-xl p-3 flex items-center justify-between gap-3"
              >
                <span className="text-sm font-medium">{studio.name}</span>
                <div className="flex items-center gap-2">
                  <StarRating
                    rating={r?.rating ?? null}
                    onChange={(rating) => rateStudio(studio.id, rating)}
                    size="sm"
                  />
                  <button
                    onClick={() => rateStudio(studio.id, null, true)}
                    className={`text-[10px] px-2 py-1 rounded-lg transition-all whitespace-nowrap ${
                      r?.notHeardOf
                        ? "bg-warning/15 text-warning border border-warning/30"
                        : "bg-card-hover text-muted border border-border"
                    }`}
                  >
                    {r?.notHeardOf ? "Unknown" : "?"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Letterboxd Import */}
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Letterboxd Import</h3>
          <p className="text-[11px] text-muted mt-0.5">
            Export your data from Letterboxd and upload the ratings CSV
          </p>
        </div>

        <div className="flex items-center gap-2">
          <label className="flex-1">
            <input
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) =>
                setLetterboxdFile(e.target.files?.[0] || null)
              }
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
          <p className="text-xs text-success animate-slide-up">
            {importStatus}
          </p>
        )}
      </div>

      {/* Integrations - Admin only */}
      {userSettings.isAdmin && (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Integrations</h2>
            <p className="text-[11px] text-muted">
              Admin only. Configure API connections for your household.
            </p>
          </div>

          {integrationConfigs.map((config) => {
            const existing = integrations.find(
              (i) => i.service === config.service
            );
            const form = forms[config.service] || {
              baseUrl: "",
              apiKey: "",
            };

            return (
              <div
                key={config.service}
                className="bg-card border border-border rounded-xl p-4 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold">{config.name}</h3>
                    <p className="text-[11px] text-muted mt-0.5">
                      {config.desc}
                    </p>
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
                    <span className="text-xs text-success animate-slide-up">
                      Saved!
                    </span>
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
            Integration settings are only available to household admins.
          </p>
        </div>
      )}
    </div>
  );
}
