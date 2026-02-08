"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import TinderMovieCard from "@/components/TinderMovieCard";
import Input from "@/components/ui/Input";
import Button from "@/components/ui/Button";

interface Movie {
  id: string;
  title: string;
  year?: number | null;
  posterUrl?: string | null;
  overview?: string | null;
  era?: string | null;
  imdbId?: string | null;
  imdbRating?: number | null;
  rottenTomatoesAudience?: number | null;
  genres?: string[];
  directors?: string[];
  actors?: string[];
  studios?: string[];
}

interface UserRating {
  movieId: string;
  rating: number | null;
  hasSeen: boolean;
  notHeardOf: boolean;
}

interface UndoAction {
  movie: Movie;
  previousRating: UserRating | null;
  hadPreviousRating: boolean;
  replacementMovie: Movie | null;
}

const PRELOAD_BATCH_SIZE = 15; // Preload this many movies at a time
const PRELOAD_THRESHOLD = 10; // Fetch more when queue drops below this
const MIN_QUEUE_SIZE = 10; // Always try to maintain at least this many movies in queue

function dedupeAndFilterMovies(movies: Movie[], excludeIds: Set<string>): Movie[] {
  const seen = new Set<string>();
  const filtered: Movie[] = [];

  for (const movie of movies) {
    if (seen.has(movie.id)) continue;
    if (excludeIds.has(movie.id)) continue;
    seen.add(movie.id);
    filtered.push(movie);
  }

  return filtered;
}

export default function RateMoviesPage() {
  const { status } = useSession();
  const router = useRouter();

  const [currentMovie, setCurrentMovie] = useState<Movie | null>(null);
  const [movieQueue, setMovieQueue] = useState<Movie[]>([]);
  const [ratings, setRatings] = useState<Map<string, UserRating>>(new Map());
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [mode, setMode] = useState<"discover" | "search">("discover");
  const [loading, setLoading] = useState(true);
  const [undoAction, setUndoAction] = useState<UndoAction | null>(null);
  const [showSearch, setShowSearch] = useState(false);

  const queueRef = useRef<Movie[]>([]);
  const ratingsRef = useRef<Map<string, UserRating>>(new Map());
  const preloadInProgressRef = useRef(false);
  const ratedMovieIdsRef = useRef<Set<string>>(new Set());
  const initialLoadDoneRef = useRef(false);

  const setQueueAndRef = useCallback((nextQueue: Movie[]) => {
    queueRef.current = nextQueue;
    setMovieQueue(nextQueue);
  }, []);

  useEffect(() => {
    ratingsRef.current = ratings;
  }, [ratings]);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  const fetchDiscoverBatch = useCallback(async (limit: number, excludeMovieIds: string[]) => {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    if (excludeMovieIds.length > 0) {
      params.set("excludeMovieIds", excludeMovieIds.join(","));
    }

    const res = await fetch(`/api/movies/discover?${params.toString()}`);
    if (!res.ok) return [];

    const data = await res.json();
    return Array.isArray(data) ? (data as Movie[]) : [];
  }, []);

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
    if (mode !== "discover") return;
    if (queueRef.current.length >= PRELOAD_THRESHOLD) return;

    preloadInProgressRef.current = true;

    try {
      const batch = await fetchDiscoverBatch(PRELOAD_BATCH_SIZE, getExcludeMovieIds());
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
  }, [fetchDiscoverBatch, getExcludeMovieIds, mode, setQueueAndRef]);

  // Initial load - only runs once
  useEffect(() => {
    if (status !== "authenticated") return;
    if (initialLoadDoneRef.current) return;

    initialLoadDoneRef.current = true;
    let cancelled = false;

    Promise.all([
      fetchDiscoverBatch(PRELOAD_BATCH_SIZE * 2, []),
      fetch("/api/ratings").then((r) => r.json()),
    ])
      .then(([discoverMovies, userRatings]) => {
        if (cancelled) return;

        // Process ratings first to know which movies to exclude
        const ratingMap = new Map<string, UserRating>();
        const ratedIds = new Set<string>();
        if (Array.isArray(userRatings)) {
          for (const rating of userRatings) {
            ratingMap.set(rating.movieId, rating);
            ratedIds.add(rating.movieId);
            ratedMovieIdsRef.current.add(rating.movieId);
          }
        }

        // Filter out already-rated movies from discover results
        const unratedMovies = dedupeAndFilterMovies(discoverMovies, ratedIds);

        // Set first unrated movie as current
        if (unratedMovies.length > 0) {
          setCurrentMovie(unratedMovies[0]);
          setQueueAndRef(unratedMovies.slice(1));
        }

        ratingsRef.current = ratingMap;
        setRatings(ratingMap);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Background preloading effect - use ref to avoid recreating interval
  const preloadMoviesRef = useRef(preloadMovies);
  preloadMoviesRef.current = preloadMovies;

  useEffect(() => {
    if (mode !== "discover" || loading) return;

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
  }, [mode, loading, setQueueAndRef]);

  const searchMovies = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setMode("search");
    setUndoAction(null);

    const res = await fetch(
      `/api/movies/search?q=${encodeURIComponent(searchQuery)}`
    );
    const data = await res.json();
    const nextMovies = Array.isArray(data) ? (data as Movie[]) : [];
    
    if (nextMovies.length > 0) {
      setCurrentMovie(nextMovies[0]);
      setQueueAndRef(nextMovies.slice(1));
    } else {
      setCurrentMovie(null);
      setQueueAndRef([]);
    }

    setSearching(false);
  }, [searchQuery, setQueueAndRef]);

  const advanceToNextMovie = useCallback(() => {
    // Skip any movies that were already rated (defensive check for race conditions)
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

    // Trigger preload check
    setTimeout(() => void preloadMovies(), 100);
  }, [preloadMovies, setQueueAndRef]);

  const persistRating = useCallback(async (payload: UserRating) => {
    await fetch("/api/ratings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }, []);

  const rateMovie = async (
    movieId: string,
    rating: number | null,
    hasSeen?: boolean,
    notHeardOf?: boolean
  ) => {
    const existing = ratingsRef.current.get(movieId);
    const payload: UserRating = {
      movieId,
      rating: notHeardOf ? null : rating,
      hasSeen: notHeardOf ? false : hasSeen ?? existing?.hasSeen ?? false,
      notHeardOf: notHeardOf ?? false,
    };

    // Track rated movies
    ratedMovieIdsRef.current.add(movieId);

    setRatings((prev) => {
      const next = new Map(prev);
      next.set(movieId, payload);
      ratingsRef.current = next;
      return next;
    });

    let replacementMovie: Movie | null = null;

    if (mode === "discover") {
      // Store for undo
      const currentMovieCopy = currentMovie;

      // Advance immediately for snappy feel
      advanceToNextMovie();

      // Fetch replacements in background to maintain queue
      const excludeIds = getExcludeMovieIds();
      const batch = await fetchDiscoverBatch(3, excludeIds);

      // Filter out any movies already in queue or already rated
      const queueIds = new Set(queueRef.current.map((m) => m.id));
      const validReplacements = batch.filter(
        (m) => !queueIds.has(m.id) && !ratedMovieIdsRef.current.has(m.id)
      );
      replacementMovie = validReplacements[0] ?? null;

      if (validReplacements.length > 0) {
        setQueueAndRef([...queueRef.current, ...validReplacements]);
      }

      setUndoAction({
        movie: currentMovieCopy!,
        previousRating: existing ?? null,
        hadPreviousRating: existing !== undefined,
        replacementMovie,
      });
    }

    await persistRating(payload);
    void preloadMovies();
  };

  const toggleSeen = useCallback(
    async (movieId: string, seen: boolean) => {
      const existing = ratingsRef.current.get(movieId);
      const payload: UserRating = {
        movieId,
        rating: existing?.rating ?? null,
        hasSeen: existing?.notHeardOf ? false : seen,
        notHeardOf: existing?.notHeardOf ?? false,
      };

      setRatings((prev) => {
        const next = new Map(prev);
        next.set(movieId, payload);
        ratingsRef.current = next;
        return next;
      });

      const hasPersistedRating =
        existing && (existing.rating !== null || existing.notHeardOf);
      if (!hasPersistedRating) return;

      await persistRating(payload);
    },
    [persistRating]
  );

  const undoLastRating = useCallback(async () => {
    if (!undoAction) return;

    const action = undoAction;
    setUndoAction(null);

    setRatings((prev) => {
      const next = new Map(prev);
      if (action.hadPreviousRating && action.previousRating) {
        next.set(action.movie.id, action.previousRating);
      } else {
        next.delete(action.movie.id);
        ratedMovieIdsRef.current.delete(action.movie.id);
      }
      ratingsRef.current = next;
      return next;
    });

    // Put the movie back as current
    if (currentMovie) {
      setQueueAndRef([currentMovie, ...queueRef.current]);
    }
    setCurrentMovie(action.movie);

    if (action.replacementMovie) {
      // Remove the replacement from queue if it was added
      const withoutReplacement = queueRef.current.filter(
        (m) => m.id !== action.replacementMovie?.id
      );
      setQueueAndRef(withoutReplacement);
    }

    if (action.hadPreviousRating && action.previousRating) {
      await persistRating(action.previousRating);
    } else {
      await fetch(`/api/ratings?movieId=${encodeURIComponent(action.movie.id)}`, {
        method: "DELETE",
      });
    }
  }, [currentMovie, persistRating, setQueueAndRef, undoAction]);

  const loadDiscoverMovies = useCallback(async () => {
    setLoading(true);
    const excludeIds = Array.from(ratedMovieIdsRef.current);
    const discoverMovies = await fetchDiscoverBatch(PRELOAD_BATCH_SIZE * 2, excludeIds);

    // Filter out any rated movies that slipped through
    const unratedMovies = dedupeAndFilterMovies(discoverMovies, ratedMovieIdsRef.current);

    if (unratedMovies.length > 0) {
      setCurrentMovie(unratedMovies[0]);
      setQueueAndRef(unratedMovies.slice(1));
    } else {
      setCurrentMovie(null);
      setQueueAndRef([]);
    }

    setMode("discover");
    setUndoAction(null);
    setLoading(false);
  }, [fetchDiscoverBatch, setQueueAndRef]);

  // Defensive check: if current movie is somehow already rated, skip it
  useEffect(() => {
    if (currentMovie && ratedMovieIdsRef.current.has(currentMovie.id)) {
      console.warn(`[Movies] Skipping already-rated movie: ${currentMovie.title}`);
      advanceToNextMovie();
    }
  }, [currentMovie, advanceToNextMovie]);

  if (status === "loading" || loading) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-muted">Loading movies...</p>
      </div>
    );
  }

  const currentRating = currentMovie ? ratings.get(currentMovie.id) : null;

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
              {movieQueue.length} queued
            </span>
          )}
          <button
            onClick={() => setShowSearch(!showSearch)}
            className={`p-2 rounded-lg transition-all ${showSearch ? "bg-accent text-white" : "bg-card-hover text-muted hover:text-foreground"}`}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Collapsible search */}
      {showSearch && (
        <div className="bg-card border border-border rounded-xl p-3 space-y-2 animate-slide-up">
          <div className="flex gap-2">
            <Input
              placeholder="Search movies..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && searchMovies()}
              autoFocus
            />
            <Button onClick={searchMovies} loading={searching} size="sm">
              Search
            </Button>
          </div>
          {mode === "search" && (
            <button
              onClick={() => {
                setSearchQuery("");
                setShowSearch(false);
                void loadDiscoverMovies();
              }}
              className="text-xs text-accent hover:underline"
            >
              Back to discover
            </button>
          )}
        </div>
      )}

      {/* Undo action bar - floating */}
      {undoAction && (
        <div className="bg-card/90 backdrop-blur-sm border border-border rounded-xl p-2.5 flex items-center justify-between gap-3 animate-slide-up">
          <p className="text-xs text-muted truncate">
            Rated <span className="text-foreground font-medium">{undoAction.movie.title}</span>
          </p>
          <button
            onClick={undoLastRating}
            className="text-xs text-accent font-medium hover:underline shrink-0"
          >
            Undo
          </button>
        </div>
      )}

      {/* Full-screen movie card */}
      {currentMovie ? (
        <TinderMovieCard
          key={currentMovie.id}
          movie={currentMovie}
          rating={currentRating?.rating ?? null}
          hasSeen={currentRating?.hasSeen ?? false}
          onRate={(value) =>
            rateMovie(currentMovie.id, value, currentRating?.hasSeen ?? false, false)
          }
          onSeenToggle={(seen) => toggleSeen(currentMovie.id, seen)}
          onNotHeardOf={() => rateMovie(currentMovie.id, null, false, true)}
        />
      ) : (
        <div className="h-[calc(100vh-180px)] min-h-[500px] flex flex-col items-center justify-center text-center">
          <div className="w-20 h-20 mx-auto bg-card-hover rounded-full flex items-center justify-center mb-4">
            <svg className="w-10 h-10 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" />
            </svg>
          </div>
          <p className="text-sm text-muted mb-4">
            {mode === "search"
              ? "No results found. Try a different search."
              : "No more movies to rate!"}
          </p>
          {mode === "discover" && (
            <Button onClick={loadDiscoverMovies} variant="secondary">
              Load More Movies
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
