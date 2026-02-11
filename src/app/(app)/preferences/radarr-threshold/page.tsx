"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import StarRating from "@/components/StarRating";
import Button from "@/components/ui/Button";

interface Candidate {
  movieId: string;
  title: string;
  year: number | null;
  posterUrl: string | null;
  overview: string | null;
  avgRating: number;
  votesCount: number;
  householdSize: number;
  votesNeeded: number;
  ratingGap: number;
  ready: boolean;
  voters: string[];
  userRating: {
    rating: number | null;
    hasSeen: boolean;
    notHeardOf: boolean;
  } | null;
}

interface HouseholdSection {
  householdId: string;
  householdName: string;
  householdSize: number;
  quorumThreshold: number;
  nearThreshold: Candidate[];
  ready: Candidate[];
}

interface NearThresholdResponse {
  households: HouseholdSection[];
  minAvgRating: number;
}

export default function RadarrThresholdPage() {
  const { status } = useSession();
  const router = useRouter();

  const [data, setData] = useState<NearThresholdResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingMovieId, setSavingMovieId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
    }
  }, [status, router]);

  const loadData = async () => {
    setError(null);
    setLoading(true);
    try {
      const response = await fetch("/api/radarr/near-threshold/mine");
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || "Could not load near-threshold movies");
      }
      const body = (await response.json()) as NearThresholdResponse;
      setData(body);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (status === "authenticated") {
      void loadData();
    }
  }, [status]);

  const submitRating = async (movieId: string, rating: number) => {
    setSavingMovieId(movieId);
    try {
      const response = await fetch("/api/ratings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          movieId,
          rating,
          hasSeen: false,
          notHeardOf: false,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || "Could not save rating");
      }
      await loadData();
    } catch (ratingError) {
      setError(ratingError instanceof Error ? ratingError.message : "Could not save rating");
    } finally {
      setSavingMovieId(null);
    }
  };

  const markNotHeardOf = async (movieId: string) => {
    setSavingMovieId(movieId);
    try {
      const response = await fetch("/api/ratings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          movieId,
          notHeardOf: true,
          hasSeen: false,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || "Could not save status");
      }
      await loadData();
    } catch (ratingError) {
      setError(ratingError instanceof Error ? ratingError.message : "Could not save status");
    } finally {
      setSavingMovieId(null);
    }
  };

  const clearRating = async (movieId: string) => {
    setSavingMovieId(movieId);
    try {
      const response = await fetch(
        `/api/ratings?movieId=${encodeURIComponent(movieId)}`,
        { method: "DELETE" }
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || "Could not clear rating");
      }
      await loadData();
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : "Could not clear rating");
    } finally {
      setSavingMovieId(null);
    }
  };

  const totalNearCount = useMemo(
    () =>
      (data?.households || []).reduce(
        (sum, household) => sum + household.nearThreshold.length,
        0
      ),
    [data]
  );

  if (status === "loading" || loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Near Radarr Threshold</h1>
          <p className="text-sm text-muted mt-1">
            Rate movies that are close to auto-sync. Your rating here is
            willingness-to-watch and counts as unseen.
          </p>
          {data && (
            <p className="text-xs text-muted mt-2">
              {totalNearCount} near-threshold title
              {totalNearCount === 1 ? "" : "s"} found.
            </p>
          )}
        </div>
        <Link href="/preferences" className="text-xs text-accent hover:underline">
          Back to Preferences
        </Link>
      </div>

      {error && (
        <div className="bg-danger/10 border border-danger/20 text-danger text-sm px-4 py-2 rounded-xl">
          {error}
        </div>
      )}

      {!data || data.households.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-6 text-sm text-muted">
          No near-threshold titles right now.
        </div>
      ) : (
        <div className="space-y-6">
          {data.households.map((household) => (
            <section key={household.householdId} className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">{household.householdName}</h2>
                  <p className="text-xs text-muted">
                    Quorum: {household.quorumThreshold} of {household.householdSize} members
                  </p>
                </div>
                <span className="text-xs bg-accent-soft text-accent px-2 py-1 rounded-full">
                  {household.nearThreshold.length} near
                </span>
              </div>

              <div className="space-y-3">
                {household.nearThreshold.map((movie) => {
                  const rating = movie.userRating?.notHeardOf
                    ? null
                    : movie.userRating?.rating ?? null;
                  const isSaving = savingMovieId === movie.movieId;

                  return (
                    <article
                      key={movie.movieId}
                      className="bg-card border border-border rounded-2xl p-3 sm:p-4"
                    >
                      <div className="flex gap-3 sm:gap-4">
                        <div className="relative w-20 h-28 sm:w-24 sm:h-36 rounded-lg overflow-hidden bg-card-hover flex-shrink-0">
                          {movie.posterUrl ? (
                            <Image
                              src={movie.posterUrl}
                              alt={movie.title}
                              fill
                              sizes="96px"
                              className="object-cover"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-[11px] text-muted px-2 text-center">
                              No poster
                            </div>
                          )}
                        </div>

                        <div className="flex-1 min-w-0 space-y-2">
                          <div>
                            <h3 className="font-semibold text-sm sm:text-base">
                              {movie.title}
                              {movie.year ? (
                                <span className="text-muted font-normal ml-1">
                                  ({movie.year})
                                </span>
                              ) : null}
                            </h3>
                            {movie.overview ? (
                              <p className="text-xs text-muted line-clamp-2 mt-1">
                                {movie.overview}
                              </p>
                            ) : null}
                          </div>

                          <div className="flex flex-wrap gap-2 text-[11px]">
                            <span className="bg-card-hover border border-border rounded-full px-2 py-0.5">
                              Avg {movie.avgRating.toFixed(2)}/5
                            </span>
                            <span className="bg-card-hover border border-border rounded-full px-2 py-0.5">
                              Votes {movie.votesCount}/{movie.householdSize}
                            </span>
                            {movie.votesNeeded > 0 ? (
                              <span className="bg-warning/10 text-warning border border-warning/30 rounded-full px-2 py-0.5">
                                Needs {movie.votesNeeded} vote
                                {movie.votesNeeded === 1 ? "" : "s"}
                              </span>
                            ) : (
                              <span className="bg-warning/10 text-warning border border-warning/30 rounded-full px-2 py-0.5">
                                Needs +{movie.ratingGap.toFixed(2)} avg
                              </span>
                            )}
                          </div>

                          <div>
                            <p className="text-[11px] text-muted mb-1">
                              Your rating (willingness to watch):
                            </p>
                            <StarRating
                              rating={rating}
                              onChange={(nextRating) => {
                                void submitRating(movie.movieId, nextRating);
                              }}
                              size="sm"
                            />
                          </div>

                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                void markNotHeardOf(movie.movieId);
                              }}
                              loading={isSaving}
                            >
                              Haven&apos;t heard of it
                            </Button>
                            {movie.userRating && (
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => {
                                  void clearRating(movie.movieId);
                                }}
                                loading={isSaving}
                              >
                                Clear
                              </Button>
                            )}
                          </div>

                          {movie.voters.length > 0 && (
                            <p className="text-[11px] text-muted">
                              Current voters: {movie.voters.join(", ")}
                            </p>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

