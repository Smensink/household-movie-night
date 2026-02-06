"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import StarRating from "@/components/StarRating";
import Button from "@/components/ui/Button";

interface SampleMovie {
  title: string;
  posterUrl?: string | null;
  year?: number | null;
  overview?: string | null;
  directors?: string[];
}

interface Studio {
  id: string;
  name: string;
  slug: string;
  sampleMovies?: SampleMovie[];
}

interface StudioRating {
  rating: number | null;
  notHeardOf: boolean;
}

export default function StudioPreferencesPage() {
  const { status } = useSession();
  const router = useRouter();
  const [studios, setStudios] = useState<Studio[]>([]);
  const [studioRatings, setStudioRatings] = useState<Record<string, StudioRating>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const studiosRef = useRef<Studio[]>([]);

  const setStudiosAndRef = useCallback((nextStudios: Studio[]) => {
    studiosRef.current = nextStudios;
    setStudios(nextStudios);
  }, []);

  useEffect(() => {
    studiosRef.current = studios;
  }, [studios]);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
    }
  }, [status, router]);

  const fetchDiscoverStudios = useCallback(
    async (limit: number, excludeIds: string[] = []): Promise<Studio[]> => {
      const params = new URLSearchParams();
      params.set("limit", String(limit));
      if (excludeIds.length > 0) {
        params.set("excludeStudioIds", excludeIds.join(","));
      }

      const response = await fetch(`/api/studios/discover?${params.toString()}`);
      if (!response.ok) return [];
      const data = await response.json();
      return Array.isArray(data) ? (data as Studio[]) : [];
    },
    []
  );

  const loadStudios = useCallback(async () => {
    setRefreshing(true);
    const [discoverData, ratingsData] = await Promise.all([
      fetchDiscoverStudios(16),
      fetch("/api/ratings/studios").then((response) => response.json()),
    ]);

    setStudiosAndRef(discoverData);
    setStudioRatings((ratingsData?.ratings || {}) as Record<string, StudioRating>);
    setRefreshing(false);
    setLoading(false);
  }, [fetchDiscoverStudios, setStudiosAndRef]);

  useEffect(() => {
    if (status === "authenticated") {
      const timeoutId = window.setTimeout(() => {
        void loadStudios();
      }, 0);
      return () => {
        window.clearTimeout(timeoutId);
      };
    }
  }, [loadStudios, status]);

  const fetchSingleReplacement = useCallback(
    async (removedStudioId: string) => {
      const exclude = Array.from(
        new Set([...studiosRef.current.map((studio) => studio.id), removedStudioId])
      );
      const replacement = await fetchDiscoverStudios(1, exclude);
      return replacement[0] ?? null;
    },
    [fetchDiscoverStudios]
  );

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

    const filtered = studiosRef.current.filter((studio) => studio.id !== studioId);
    setStudiosAndRef(filtered);

    const replacement = await fetchSingleReplacement(studioId);
    if (replacement) {
      setStudiosAndRef([...studiosRef.current, replacement]);
    }
  };

  if (status === "loading" || loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const activeStudio = studios[0];
  const activeRating = activeStudio ? studioRatings[activeStudio.id] : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Rate Studios</h1>
          <p className="text-sm text-muted mt-1">
            Tinder-style studio ranking with rich movie previews.
          </p>
        </div>
        <Link href="/preferences" className="text-xs text-accent hover:underline">
          Back
        </Link>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted">
          {studios.length > 0
            ? `${studios.length} suggestions loaded`
            : "No studio suggestions loaded"}
        </p>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void loadStudios()}
          loading={refreshing}
        >
          Refresh
        </Button>
      </div>

      {activeStudio ? (
        <div className="bg-card border border-border rounded-3xl p-5 lg:p-7 space-y-5 animate-slide-up">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-2xl font-semibold">{activeStudio.name}</h2>
            <span className="text-[11px] text-muted uppercase tracking-wide">
              Studio Pick
            </span>
          </div>

          {activeStudio.sampleMovies && activeStudio.sampleMovies.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-muted">
                Hover a poster for details. On mobile, tap and hold.
              </p>
              <div className="flex gap-3 overflow-x-auto pb-2">
                {activeStudio.sampleMovies.map((movie) => (
                  <div
                    key={`${activeStudio.id}-${movie.title}`}
                    className="group relative w-28 h-40 sm:w-32 sm:h-48 rounded-xl overflow-hidden border border-border bg-card-hover flex-shrink-0"
                  >
                    {movie.posterUrl ? (
                      <Image
                        src={movie.posterUrl}
                        alt={movie.title}
                        fill
                        sizes="(max-width: 768px) 112px, 128px"
                        className="object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center px-2 text-[10px] text-center text-muted">
                        {movie.title}
                      </div>
                    )}
                    <div className="absolute inset-0 bg-black/80 text-white p-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity overflow-y-auto">
                      <p className="text-[11px] font-semibold leading-tight">
                        {movie.title}
                        {movie.year ? ` (${movie.year})` : ""}
                      </p>
                      {movie.directors && movie.directors.length > 0 && (
                        <p className="text-[10px] mt-1 text-white/80">
                          Director: {movie.directors.join(", ")}
                        </p>
                      )}
                      {movie.overview && (
                        <p className="text-[10px] mt-1 text-white/80 line-clamp-6">
                          {movie.overview}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="bg-background/30 border border-border rounded-2xl p-4 space-y-2">
            <p className="text-xs text-muted">
              How much do you like movies from this studio?
            </p>
            <StarRating
              rating={activeRating?.rating ?? null}
              onChange={(value) => rateStudio(activeStudio.id, value)}
              size="md"
            />
            <button
              onClick={() => rateStudio(activeStudio.id, null, true)}
              className={`text-xs px-3 py-1.5 rounded-lg transition-all ${
                activeRating?.notHeardOf
                  ? "bg-warning/15 text-warning border border-warning/30"
                  : "bg-card-hover text-muted border border-border hover:text-foreground"
              }`}
            >
              {activeRating?.notHeardOf
                ? "You marked this studio as unknown"
                : "I don't know this studio"}
            </button>
          </div>
        </div>
      ) : (
        <div className="text-center py-10 text-sm text-muted">
          No studio suggestions available yet.
        </div>
      )}
    </div>
  );
}
