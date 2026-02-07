"use client";

import { useEffect, useState, useCallback } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import StarRating from "@/components/StarRating";
import Button from "@/components/ui/Button";

interface UpcomingMovie {
  id: string;
  imdbId: string | null;
  tmdbId: string | null;
  title: string;
  year: number | null;
  posterUrl: string | null;
  overview: string | null;
  releaseDate: string | null;
  listCount: number;
  actors: string[];
  directors: string[];
  studios: string[];
  consensus: {
    ratingCount: number;
    averageRating: number | null;
    userRating: number | null;
  };
  radarrStatus: {
    inRadarr: boolean;
    available: boolean;
    monitored: boolean;
  } | null;
}

interface UserRating {
  movieId: string;
  rating: number | null;
  notHeardOf: boolean;
}

const CONSENSUS_THRESHOLD = 2; // Minimum users with 4+ rating
const MIN_RATING = 4; // Minimum rating to count toward consensus

export default function UpcomingMoviesPage() {
  const { status } = useSession();
  const router = useRouter();

  const [movies, setMovies] = useState<UpcomingMovie[]>([]);
  const [ratings, setRatings] = useState<Map<string, UserRating>>(new Map());
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{
    success: number;
    failed: number;
  } | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  const fetchMovies = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/movies/upcoming?limit=20");
      if (res.ok) {
        const data = await res.json();
        setMovies(data);
        // Initialize ratings from fetched data
        const ratingMap = new Map<string, UserRating>();
        data.forEach((movie: UpcomingMovie) => {
          if (movie.consensus.userRating) {
            ratingMap.set(movie.id, {
              movieId: movie.id,
              rating: movie.consensus.userRating,
              notHeardOf: false,
            });
          }
        });
        setRatings(ratingMap);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === "authenticated") {
      void fetchMovies();
    }
  }, [fetchMovies, status]);

  const rateMovie = async (
    movieId: string,
    rating: number | null,
    notHeardOf: boolean = false
  ) => {
    // Update local state immediately
    setRatings((prev) => {
      const next = new Map(prev);
      next.set(movieId, { movieId, rating, notHeardOf });
      return next;
    });

    // Update movie consensus locally
    setMovies((prev) =>
      prev.map((m) => {
        if (m.id !== movieId) return m;
        const newConsensus = { ...m.consensus };
        if (!notHeardOf && rating !== null) {
          newConsensus.userRating = rating;
          // Recalculate average and count
          const existingCount = newConsensus.ratingCount;
          const existingAvg = newConsensus.averageRating || 0;
          // Approximate new average (simplified)
          if (existingCount === 0) {
            newConsensus.averageRating = rating;
            newConsensus.ratingCount = 1;
          } else {
            newConsensus.averageRating =
              (existingAvg * existingCount + rating) / (existingCount + 1);
            newConsensus.ratingCount = existingCount + 1;
          }
        }
        return { ...m, consensus: newConsensus };
      })
    );

    // Persist to API
    await fetch("/api/ratings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ movieId, rating, notHeardOf, hasSeen: false }),
    });
  };

  const syncConsensusToRadarr = async () => {
    // Find movies with strong consensus (2+ users, 4+ rating, not in Radarr)
    const consensusMovies = movies.filter((m) => {
      if (m.radarrStatus?.inRadarr) return false;
      return (
        m.consensus.ratingCount >= CONSENSUS_THRESHOLD &&
        (m.consensus.averageRating || 0) >= MIN_RATING
      );
    });

    if (consensusMovies.length === 0) {
      alert("No movies with strong consensus to sync.");
      return;
    }

    setSyncing(true);
    try {
      const res = await fetch("/api/movies/upcoming/sync-radarr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ movieIds: consensusMovies.map((m) => m.id) }),
      });

      if (res.ok) {
        const data = await res.json();
        const success = data.results.filter(
          (r: { result: { success: boolean } }) => r.result.success
        ).length;
        const failed = data.results.length - success;
        setSyncResult({ success, failed });
        // Refresh to get updated Radarr status
        await fetchMovies();
      } else {
        const error = await res.json();
        alert(`Sync failed: ${error.error || "Unknown error"}`);
      }
    } finally {
      setSyncing(false);
    }
  };

  const getConsensusStatus = (movie: UpcomingMovie) => {
    if (movie.radarrStatus?.inRadarr) {
      return {
        label: movie.radarrStatus.available
          ? "Available"
          : movie.radarrStatus.monitored
          ? "Monitored"
          : "In Radarr",
        color: movie.radarrStatus.available
          ? "bg-success/20 text-success"
          : "bg-accent/20 text-accent",
      };
    }

    const meetsConsensus =
      movie.consensus.ratingCount >= CONSENSUS_THRESHOLD &&
      (movie.consensus.averageRating || 0) >= MIN_RATING;

    if (meetsConsensus) {
      return {
        label: `Consensus met! (${movie.consensus.ratingCount} users)`,
        color: "bg-success/20 text-success",
      };
    }

    if (movie.consensus.ratingCount > 0) {
      return {
        label: `${movie.consensus.ratingCount} rated`,
        color: "bg-warning/20 text-warning",
      };
    }

    return {
      label: "Not rated",
      color: "bg-muted/20 text-muted",
    };
  };

  if (status === "loading" || loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const currentMovie = movies[currentIndex];
  const consensusMovies = movies.filter((m) => {
    if (m.radarrStatus?.inRadarr) return false;
    return (
      m.consensus.ratingCount >= CONSENSUS_THRESHOLD &&
      (m.consensus.averageRating || 0) >= MIN_RATING
    );
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Upcoming Movies</h1>
          <p className="text-sm text-muted mt-1">
            Anticipated releases. Rate to build consensus for Radarr.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {consensusMovies.length > 0 && (
            <Button
              size="sm"
              onClick={syncConsensusToRadarr}
              loading={syncing}
            >
              Sync {consensusMovies.length} to Radarr
            </Button>
          )}
        </div>
      </div>

      {/* Sync result */}
      {syncResult && (
        <div
          className={`p-3 rounded-xl text-sm ${
            syncResult.failed === 0
              ? "bg-success/15 text-success border border-success/30"
              : "bg-warning/15 text-warning border border-warning/30"
          }`}
        >
          Sync complete: {syncResult.success} added
          {syncResult.failed > 0 && `, ${syncResult.failed} failed`}
          <button
            onClick={() => setSyncResult(null)}
            className="ml-2 text-xs underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-card border border-border rounded-xl p-3 text-center">
          <div className="text-2xl font-bold text-accent">{movies.length}</div>
          <div className="text-[10px] text-muted uppercase tracking-wide">
            Upcoming
          </div>
        </div>
        <div className="bg-card border border-border rounded-xl p-3 text-center">
          <div className="text-2xl font-bold text-warning">
            {
              movies.filter(
                (m) =>
                  m.consensus.ratingCount > 0 && !m.radarrStatus?.inRadarr
              ).length
            }
          </div>
          <div className="text-[10px] text-muted uppercase tracking-wide">
            Rated
          </div>
        </div>
        <div className="bg-card border border-border rounded-xl p-3 text-center">
          <div className="text-2xl font-bold text-success">
            {movies.filter((m) => m.radarrStatus?.inRadarr).length}
          </div>
          <div className="text-[10px] text-muted uppercase tracking-wide">
            In Radarr
          </div>
        </div>
      </div>

      {/* Movie navigation */}
      {movies.length > 0 && (
        <div className="flex items-center justify-between">
          <button
            onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
            disabled={currentIndex === 0}
            className="p-2 rounded-lg bg-card border border-border disabled:opacity-30"
          >
            ← Prev
          </button>
          <span className="text-sm text-muted">
            {currentIndex + 1} / {movies.length}
          </span>
          <button
            onClick={() =>
              setCurrentIndex((i) => Math.min(movies.length - 1, i + 1))
            }
            disabled={currentIndex === movies.length - 1}
            className="p-2 rounded-lg bg-card border border-border disabled:opacity-30"
          >
            Next →
          </button>
        </div>
      )}

      {/* Current movie card */}
      {currentMovie ? (
        <div className="bg-card border border-border rounded-3xl overflow-hidden">
          {/* Poster */}
          <div className="relative h-64 sm:h-80 bg-card-hover">
            {currentMovie.posterUrl ? (
              <Image
                src={currentMovie.posterUrl}
                alt={currentMovie.title}
                fill
                className="object-contain"
                sizes="(max-width: 768px) 100vw, 600px"
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-muted">
                <svg
                  className="w-16 h-16"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z"
                  />
                </svg>
              </div>
            )}

            {/* Status badge */}
            <div className="absolute top-3 right-3">
              <span
                className={`px-3 py-1 rounded-full text-xs font-medium ${
                  getConsensusStatus(currentMovie).color
                }`}
              >
                {getConsensusStatus(currentMovie).label}
              </span>
            </div>
          </div>

          {/* Info */}
          <div className="p-5 space-y-4">
            <div>
              <h2 className="text-xl font-bold">{currentMovie.title}</h2>
              <div className="flex items-center gap-3 mt-1 text-sm text-muted">
                {currentMovie.year && <span>{currentMovie.year}</span>}
                <span>•</span>
                <span>{currentMovie.listCount} lists</span>
                {currentMovie.releaseDate && (
                  <>
                    <span>•</span>
                    <span>
                      Releases{" "}
                      {new Date(currentMovie.releaseDate).toLocaleDateString()}
                    </span>
                  </>
                )}
              </div>
            </div>

            {/* Metadata */}
            {(currentMovie.directors.length > 0 ||
              currentMovie.actors.length > 0) && (
              <div className="space-y-1 text-sm">
                {currentMovie.directors.length > 0 && (
                  <p className="text-muted">
                    Director:{" "}
                    <span className="text-foreground">
                      {currentMovie.directors.join(", ")}
                    </span>
                  </p>
                )}
                {currentMovie.actors.length > 0 && (
                  <p className="text-muted">
                    Starring:{" "}
                    <span className="text-foreground">
                      {currentMovie.actors.join(", ")}
                    </span>
                  </p>
                )}
              </div>
            )}

            {currentMovie.overview && (
              <p className="text-sm text-muted line-clamp-3">
                {currentMovie.overview}
              </p>
            )}

            {/* Rating section */}
            {!currentMovie.radarrStatus?.inRadarr && (
              <div className="bg-background/50 rounded-2xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">
                    Your interest level
                  </span>
                  {currentMovie.consensus.ratingCount > 0 && (
                    <span className="text-xs text-muted">
                      Avg: {currentMovie.consensus.averageRating?.toFixed(1)}★
                      from {currentMovie.consensus.ratingCount} users
                    </span>
                  )}
                </div>

                <div className="flex justify-center">
                  <StarRating
                    rating={
                      ratings.get(currentMovie.id)?.rating ??
                      currentMovie.consensus.userRating ??
                      null
                    }
                    onChange={(value) => rateMovie(currentMovie.id, value)}
                    size="lg"
                  />
                </div>

                <button
                  onClick={() => rateMovie(currentMovie.id, null, true)}
                  className={`w-full py-2 rounded-xl text-xs transition-all ${
                    ratings.get(currentMovie.id)?.notHeardOf
                      ? "bg-warning/15 text-warning border border-warning/30"
                      : "bg-card-hover text-muted border border-border hover:text-foreground"
                  }`}
                >
                  {ratings.get(currentMovie.id)?.notHeardOf
                    ? "Marked as unknown"
                    : "I haven't heard of this"}
                </button>

                {/* Consensus progress */}
                <div className="pt-2 border-t border-border">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted">Consensus progress</span>
                    <span
                      className={`font-medium ${
                        currentMovie.consensus.ratingCount >=
                          CONSENSUS_THRESHOLD &&
                        (currentMovie.consensus.averageRating || 0) >=
                          MIN_RATING
                          ? "text-success"
                          : "text-muted"
                      }`}
                    >
                      {currentMovie.consensus.ratingCount}/
                      {CONSENSUS_THRESHOLD} users @ {MIN_RATING}★
                    </span>
                  </div>
                  <div className="mt-1 h-2 bg-border rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        currentMovie.consensus.ratingCount >=
                          CONSENSUS_THRESHOLD &&
                        (currentMovie.consensus.averageRating || 0) >=
                          MIN_RATING
                          ? "bg-success"
                          : "bg-accent"
                      }`}
                      style={{
                        width: `${Math.min(
                          100,
                          (currentMovie.consensus.ratingCount /
                            CONSENSUS_THRESHOLD) *
                            100
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Already in Radarr message */}
            {currentMovie.radarrStatus?.inRadarr && (
              <div className="bg-success/10 border border-success/30 rounded-2xl p-4 text-center">
                <p className="text-success font-medium">
                  ✓ Added to Radarr
                  {currentMovie.radarrStatus.available
                    ? " and available"
                    : currentMovie.radarrStatus.monitored
                    ? " (monitoring)"
                    : ""}
                </p>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="text-center py-12">
          <p className="text-muted">No upcoming movies found.</p>
        </div>
      )}

      {/* Movie list preview */}
      {movies.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">All Upcoming</h3>
          <div className="space-y-2">
            {movies.map((movie, index) => (
              <button
                key={movie.id}
                onClick={() => setCurrentIndex(index)}
                className={`w-full flex items-center gap-3 p-2 rounded-xl text-left transition-all ${
                  index === currentIndex
                    ? "bg-accent/10 border border-accent/30"
                    : "bg-card border border-border hover:border-accent/30"
                }`}
              >
                <div className="w-10 h-14 bg-card-hover rounded-lg overflow-hidden flex-shrink-0 relative">
                  {movie.posterUrl ? (
                    <Image
                      src={movie.posterUrl}
                      alt={movie.title}
                      fill
                      className="object-cover"
                      sizes="40px"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[8px] text-muted">
                      No img
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{movie.title}</p>
                  <p className="text-xs text-muted">
                    {movie.year} • {movie.listCount} lists
                  </p>
                </div>
                {movie.radarrStatus?.inRadarr ? (
                  <span className="text-xs text-success">✓</span>
                ) : movie.consensus.ratingCount >= CONSENSUS_THRESHOLD ? (
                  <span className="text-xs text-success font-medium">
                    {movie.consensus.ratingCount}★
                  </span>
                ) : movie.consensus.ratingCount > 0 ? (
                  <span className="text-xs text-warning">
                    {movie.consensus.ratingCount}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
