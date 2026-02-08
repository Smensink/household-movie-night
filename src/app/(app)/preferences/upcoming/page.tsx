"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import TinderMovieCard from "@/components/TinderMovieCard";
import Button from "@/components/ui/Button";

interface UpcomingMovie {
  id: string;
  imdbId: string | null;
  tmdbId: string | null;
  title: string;
  year: number | null;
  posterUrl: string | null;
  overview: string | null;
  tmdbRating: number | null;
  imdbRating: number | null;
  rottenTomatoesAudience: number | null;
  releaseDate: string | null;
  listCount: number;
  genres: string[];
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

interface RatedMovieEntry {
  movieId: string;
  rating: number | null;
  notHeardOf: boolean;
}

const CONSENSUS_THRESHOLD = 2;
const MIN_RATING = 4;
const PRELOAD_BATCH_SIZE = 15; // Preload this many movies at a time
const PRELOAD_THRESHOLD = 10; // Fetch more when queue drops below this

export default function UpcomingMoviesPage() {
  const { status } = useSession();
  const router = useRouter();

  const [currentMovie, setCurrentMovie] = useState<UpcomingMovie | null>(null);
  const [movieQueue, setMovieQueue] = useState<UpcomingMovie[]>([]);
  const [ratings, setRatings] = useState<Map<string, UserRating>>(new Map());
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{
    success: number;
    failed: number;
  } | null>(null);

  const queueRef = useRef<UpcomingMovie[]>([]);
  const ratingsRef = useRef<Map<string, UserRating>>(new Map());
  const ratedMovieIdsRef = useRef<Set<string>>(new Set());
  const initialLoadDoneRef = useRef(false);
  const preloadInProgressRef = useRef(false);

  // Deduplicate and filter out rated movies
  const dedupeAndFilterMovies = useCallback(
    (movies: UpcomingMovie[], excludeIds: Set<string>): UpcomingMovie[] => {
      const seen = new Set<string>();
      const filtered: UpcomingMovie[] = [];
      for (const movie of movies) {
        if (seen.has(movie.id)) continue;
        if (excludeIds.has(movie.id)) continue;
        if (movie.consensus.userRating !== null) continue;
        seen.add(movie.id);
        filtered.push(movie);
      }
      return filtered;
    },
    []
  );

  const setQueueAndRef = useCallback((nextQueue: UpcomingMovie[]) => {
    queueRef.current = nextQueue;
    setMovieQueue(nextQueue);
  }, []);

  useEffect(() => {
    ratingsRef.current = ratings;
  }, [ratings]);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  const fetchUpcomingBatch = useCallback(async (limit: number, excludeIds: string[] = []) => {
    const params = new URLSearchParams({
      limit: String(limit),
      excludeRadarr: "true",
      excludeRated: "true",
    });
    if (excludeIds.length > 0) {
      params.set("excludeMovieIds", excludeIds.join(","));
    }
    const res = await fetch(`/api/movies/upcoming?${params.toString()}`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? (data as UpcomingMovie[]) : [];
  }, []);

  // Get IDs to exclude from next fetch
  const getExcludeMovieIds = useCallback(() => {
    return Array.from(
      new Set([
        ...(currentMovie ? [currentMovie.id] : []),
        ...queueRef.current.map((movie) => movie.id),
        ...Array.from(ratedMovieIdsRef.current),
      ])
    );
  }, [currentMovie]);

  // Preload movies in background
  const preloadMovies = useCallback(async () => {
    if (preloadInProgressRef.current) return;
    if (queueRef.current.length >= PRELOAD_THRESHOLD) return;

    preloadInProgressRef.current = true;

    try {
      const batch = await fetchUpcomingBatch(PRELOAD_BATCH_SIZE, getExcludeMovieIds());
      if (batch.length > 0) {
        const merged = dedupeAndFilterMovies(
          [...queueRef.current, ...batch],
          ratedMovieIdsRef.current
        );
        setQueueAndRef(merged);
      }
    } finally {
      preloadInProgressRef.current = false;
    }
  }, [fetchUpcomingBatch, getExcludeMovieIds, dedupeAndFilterMovies, setQueueAndRef]);

  // Initial load
  useEffect(() => {
    if (status !== "authenticated") return;
    if (initialLoadDoneRef.current) return;

    initialLoadDoneRef.current = true;
    let cancelled = false;

    Promise.all([
      fetchUpcomingBatch(PRELOAD_BATCH_SIZE * 2, []),
      fetch("/api/ratings").then((r) => r.json()),
    ])
      .then(([movies, userRatings]) => {
        if (cancelled) return;

        const ratingMap = new Map<string, UserRating>();
        const ratedIds = new Set<string>();
        if (Array.isArray(userRatings)) {
          for (const rating of userRatings as RatedMovieEntry[]) {
            ratingMap.set(rating.movieId, {
              movieId: rating.movieId,
              rating: rating.rating,
              notHeardOf: rating.notHeardOf,
            });
            ratedIds.add(rating.movieId);
            ratedMovieIdsRef.current.add(rating.movieId);
          }
        }

        const unratedMovies = dedupeAndFilterMovies(movies, ratedIds);

        if (unratedMovies.length > 0) {
          setCurrentMovie(unratedMovies[0]);
          setQueueAndRef(unratedMovies.slice(1));
        }

        ratingsRef.current = ratingMap;
        setRatings(ratingMap);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [status, fetchUpcomingBatch, dedupeAndFilterMovies, setQueueAndRef]);

  // Background preloading effect - use ref to avoid recreating interval
  const preloadMoviesRef = useRef(preloadMovies);
  preloadMoviesRef.current = preloadMovies;

  // If queue has items but no current card, promote next queued movie.
  useEffect(() => {
    if (loading) return;
    if (currentMovie) return;
    if (queueRef.current.length === 0) return;

    const [next, ...rest] = queueRef.current;
    setCurrentMovie(next);
    setQueueAndRef(rest);
  }, [currentMovie, loading, setQueueAndRef]);

  // When user runs out, keep trying to refill in background.
  useEffect(() => {
    if (loading) return;
    if (currentMovie) return;
    if (queueRef.current.length > 0) return;

    void preloadMovies();
  }, [currentMovie, loading, preloadMovies]);
  useEffect(() => {
    if (loading) return;

    const interval = setInterval(() => {
      // Clean queue of any rated movies that might have slipped through
      const cleanedQueue = queueRef.current.filter(
        (m) => !ratedMovieIdsRef.current.has(m.id)
      );
      if (cleanedQueue.length !== queueRef.current.length) {
        setQueueAndRef(cleanedQueue);
      }
      void preloadMoviesRef.current();
    }, 2000);

    return () => clearInterval(interval);
  }, [loading, setQueueAndRef]);

  const advanceToNextMovie = useCallback(() => {
    // Skip any movies that were already rated
    let queue = queueRef.current;
    while (queue.length > 0 && ratedMovieIdsRef.current.has(queue[0].id)) {
      queue = queue.slice(1);
    }

    if (queue.length > 0) {
      const [next, ...rest] = queue;
      setCurrentMovie(next);
      setQueueAndRef(rest);
    } else {
      setCurrentMovie(null);
      setQueueAndRef([]);
    }

    // Trigger preload check after a short delay
    setTimeout(() => void preloadMovies(), 100);
  }, [setQueueAndRef, preloadMovies]);

  const persistRating = useCallback(async (payload: UserRating) => {
    await fetch("/api/ratings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, hasSeen: false }),
    });
  }, []);

  const rateMovie = async (
    movieId: string,
    rating: number | null,
    notHeardOf: boolean = false
  ) => {
    const payload: UserRating = {
      movieId,
      rating: notHeardOf ? null : rating,
      notHeardOf,
    };

    // Track rated movies
    ratedMovieIdsRef.current.add(movieId);

    setRatings((prev) => {
      const next = new Map(prev);
      next.set(movieId, payload);
      ratingsRef.current = next;
      return next;
    });

    // Advance to next movie
    advanceToNextMovie();

    // Persist rating
    await persistRating(payload);
  };

  const syncConsensusToRadarr = async () => {
    // We need to fetch all movies to find consensus ones
    const res = await fetch(`/api/movies/upcoming?limit=30`);
    if (!res.ok) return;

    const allMovies: UpcomingMovie[] = await res.json();
    const consensusMovies = allMovies.filter((m) => {
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
      const syncRes = await fetch("/api/movies/upcoming", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ movieIds: consensusMovies.map((m) => m.id) }),
      });

      if (syncRes.ok) {
        const data = await syncRes.json();
        const success = data.results.filter(
          (r: { result: { success: boolean } }) => r.result.success
        ).length;
        const failed = data.results.length - success;
        setSyncResult({ success, failed });
      } else {
        const error = await syncRes.json();
        alert(`Sync failed: ${error.error || "Unknown error"}`);
      }
    } finally {
      setSyncing(false);
    }
  };

  const loadMoreMovies = useCallback(async () => {
    setLoading(true);
    const movies = await fetchUpcomingBatch(PRELOAD_BATCH_SIZE * 2);

    const unratedMovies = movies.filter(
      (m) => !ratedMovieIdsRef.current.has(m.id) && m.consensus.userRating === null
    );

    if (unratedMovies.length > 0) {
      setCurrentMovie(unratedMovies[0]);
      setQueueAndRef(unratedMovies.slice(1));
    } else {
      setCurrentMovie(null);
      setQueueAndRef([]);
    }

    setLoading(false);
  }, [fetchUpcomingBatch, setQueueAndRef]);

  // Defensive check: if current movie is somehow already rated, skip it
  useEffect(() => {
    if (currentMovie && ratedMovieIdsRef.current.has(currentMovie.id)) {
      advanceToNextMovie();
    }
  }, [currentMovie, advanceToNextMovie]);

  if (status === "loading" || loading) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-muted">Loading upcoming movies...</p>
      </div>
    );
  }

  const currentRating = currentMovie ? ratings.get(currentMovie.id) : null;

  const formatReleaseDate = (dateStr: string | null) => {
    if (!dateStr) return null;
    const date = new Date(dateStr);
    const now = new Date();
    const diffDays = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays < 0) return "Released";
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Tomorrow";
    if (diffDays <= 7) return `In ${diffDays} days`;
    if (diffDays <= 30) return `In ${Math.ceil(diffDays / 7)} weeks`;
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  return (
    <div className="space-y-3">
      {/* Compact header bar */}
      <div className="flex items-center justify-between gap-2">
        <Link href="/preferences" className="text-xs text-accent hover:underline flex items-center gap-1">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </Link>
        <div className="flex items-center gap-3">
          {movieQueue.length > 0 && (
            <span className="text-[10px] text-muted bg-card-hover px-2 py-0.5 rounded-full">
              {movieQueue.length} more
            </span>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={syncConsensusToRadarr}
            loading={syncing}
          >
            Sync to Radarr
          </Button>
        </div>
      </div>

      {/* Sync result notification */}
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

      {/* Current movie card */}
      {currentMovie ? (
        <div className="space-y-3">
          {/* Release date and consensus info bar */}
          <div className="flex items-center justify-between bg-card border border-border rounded-xl p-3">
            <div className="flex items-center gap-3">
              {currentMovie.releaseDate && (
                <div className="flex items-center gap-1.5">
                  <svg className="w-4 h-4 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <span className="text-sm font-medium">
                    {formatReleaseDate(currentMovie.releaseDate)}
                  </span>
                </div>
              )}
              <span className="text-xs text-muted">
                {currentMovie.listCount} anticipation lists
              </span>
            </div>

            {/* Consensus indicator */}
            <div className="flex items-center gap-2">
              {currentMovie.consensus.ratingCount > 0 && (
                <span className="text-xs text-muted">
                  {currentMovie.consensus.ratingCount}/{CONSENSUS_THRESHOLD} rated
                </span>
              )}
              <div className="w-16 h-1.5 bg-border rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    currentMovie.consensus.ratingCount >= CONSENSUS_THRESHOLD &&
                    (currentMovie.consensus.averageRating || 0) >= MIN_RATING
                      ? "bg-success"
                      : "bg-accent"
                  }`}
                  style={{
                    width: `${Math.min(100, (currentMovie.consensus.ratingCount / CONSENSUS_THRESHOLD) * 100)}%`,
                  }}
                />
              </div>
            </div>
          </div>

          {/* Tinder card */}
          <TinderMovieCard
            key={currentMovie.id}
            movie={{
              id: currentMovie.id,
              title: currentMovie.title,
              year: currentMovie.year,
              posterUrl: currentMovie.posterUrl,
              overview: currentMovie.overview,
              imdbId: currentMovie.imdbId,
              tmdbRating: currentMovie.tmdbRating,
              imdbRating: currentMovie.imdbRating,
              rottenTomatoesAudience: currentMovie.rottenTomatoesAudience,
              genres: currentMovie.genres,
              anticipatedListCount: currentMovie.listCount,
              directors: currentMovie.directors,
              actors: currentMovie.actors,
              studios: currentMovie.studios,
            }}
            rating={currentRating?.rating ?? null}
            onRate={(value) => rateMovie(currentMovie.id, value)}
            onNotHeardOf={() => rateMovie(currentMovie.id, null, true)}
          />

          {/* Household consensus info */}
          {currentMovie.consensus.ratingCount > 0 && (
            <div className="bg-card border border-border rounded-xl p-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted">Household interest</span>
                <div className="flex items-center gap-2">
                  <span className="font-semibold">
                    {currentMovie.consensus.averageRating?.toFixed(1)}★
                  </span>
                  <span className="text-xs text-muted">
                    from {currentMovie.consensus.ratingCount} member{currentMovie.consensus.ratingCount !== 1 ? "s" : ""}
                  </span>
                </div>
              </div>
              {currentMovie.consensus.ratingCount >= CONSENSUS_THRESHOLD &&
                (currentMovie.consensus.averageRating || 0) >= MIN_RATING && (
                <p className="text-xs text-success mt-1">
                  Consensus reached! Will be synced to Radarr.
                </p>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="h-[calc(100vh-180px)] min-h-[500px] flex flex-col items-center justify-center text-center">
          <div className="w-20 h-20 mx-auto bg-card-hover rounded-full flex items-center justify-center mb-4">
            <svg className="w-10 h-10 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
          <p className="text-sm text-muted mb-4">
            No more upcoming movies to rate!
          </p>
          <Button onClick={loadMoreMovies} variant="secondary">
            Check for More
          </Button>
        </div>
      )}
    </div>
  );
}



