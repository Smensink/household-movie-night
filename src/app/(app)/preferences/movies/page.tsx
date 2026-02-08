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
  tmdbRating?: number | null;
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

interface RatedMovieEntry extends UserRating {
  id: string;
  updatedAt: string;
  movie: {
    id: string;
    title: string;
    year?: number | null;
    posterUrl?: string | null;
  };
}

interface UndoAction {
  movie: Movie;
  previousRating: UserRating | null;
  hadPreviousRating: boolean;
  replacementMovie: Movie | null;
}

const PRELOAD_BATCH_SIZE = 15; // Preload this many movies at a time
const PRELOAD_THRESHOLD = 10; // Fetch more when queue drops below this

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

function mergeRatedMoviesPreserveOrder(
  existing: RatedMovieEntry[],
  incoming: RatedMovieEntry[]
): RatedMovieEntry[] {
  if (existing.length === 0) return incoming;

  const incomingByMovieId = new Map<string, RatedMovieEntry>();
  for (const item of incoming) {
    incomingByMovieId.set(item.movieId, item);
  }

  const merged: RatedMovieEntry[] = [];
  for (const item of existing) {
    const updated = incomingByMovieId.get(item.movieId);
    if (updated) {
      merged.push(updated);
      incomingByMovieId.delete(item.movieId);
    }
  }

  // New items not in current list get appended to avoid scroll jumps.
  for (const item of incoming) {
    if (incomingByMovieId.has(item.movieId)) {
      merged.push(item);
      incomingByMovieId.delete(item.movieId);
    }
  }

  return merged;
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
  const [showRatedMovies, setShowRatedMovies] = useState(false);
  const [ratedMoviesSearch, setRatedMoviesSearch] = useState("");
  const [ratedMovies, setRatedMovies] = useState<RatedMovieEntry[]>([]);
  const [updatingRatedMovieId, setUpdatingRatedMovieId] = useState<string | null>(null);

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
          setRatedMovies(userRatings as RatedMovieEntry[]);
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

  const syncRatingsFromServer = useCallback(async () => {
    const res = await fetch("/api/ratings");
    if (!res.ok) return;

    const data = await res.json();
    if (!Array.isArray(data)) return;

    const ratingMap = new Map<string, UserRating>();
    const ratedIds = new Set<string>();

    for (const rating of data as RatedMovieEntry[]) {
      ratingMap.set(rating.movieId, {
        movieId: rating.movieId,
        rating: rating.rating,
        hasSeen: rating.hasSeen,
        notHeardOf: rating.notHeardOf,
      });
      ratedIds.add(rating.movieId);
    }

    ratingsRef.current = ratingMap;
    ratedMovieIdsRef.current = ratedIds;
    setRatings(ratingMap);
    const nextRatedMovies = data as RatedMovieEntry[];
    setRatedMovies((prev) =>
      mergeRatedMoviesPreserveOrder(prev, nextRatedMovies)
    );
  }, []);

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
    void syncRatingsFromServer();
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
      void syncRatingsFromServer();
    },
    [persistRating, syncRatingsFromServer]
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
    void syncRatingsFromServer();
  }, [currentMovie, persistRating, setQueueAndRef, syncRatingsFromServer, undoAction]);

  const updateRatedMovie = useCallback(
    async (
      entry: RatedMovieEntry,
      updates: Partial<Pick<UserRating, "rating" | "hasSeen" | "notHeardOf">>
    ) => {
      const nextNotHeardOf = updates.notHeardOf ?? entry.notHeardOf;
      const nextRating = nextNotHeardOf ? null : updates.rating ?? entry.rating;
      const nextHasSeen = nextNotHeardOf
        ? false
        : updates.hasSeen ?? entry.hasSeen;

      if (!nextNotHeardOf && (nextRating === null || nextRating < 1 || nextRating > 5)) {
        return;
      }

      setUpdatingRatedMovieId(entry.movieId);
      await persistRating({
        movieId: entry.movieId,
        rating: nextRating,
        hasSeen: nextHasSeen,
        notHeardOf: nextNotHeardOf,
      });
      await syncRatingsFromServer();
      setUpdatingRatedMovieId(null);
    },
    [persistRating, syncRatingsFromServer]
  );

  const loadDiscoverMovies = useCallback(async () => {
    setLoading(true);
    const discoverMovies = await fetchDiscoverBatch(PRELOAD_BATCH_SIZE * 2, []);

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

  const submitRecommendationFeedback = async (movie: Movie) => {
    const response = window.prompt(
      `What feedback do you have about recommending "${movie.title}"?`,
      ""
    );

    if (response === null) return;

    const message = response.trim();
    if (!message) {
      window.alert("Please add a short note so we can improve recommendations.");
      return;
    }

    const res = await fetch("/api/feedback/recommendations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context: "discover",
        movieId: movie.id,
        message,
      }),
    });

    if (!res.ok) {
      window.alert("Could not submit feedback right now.");
      return;
    }

    window.alert("Thanks. Your feedback was saved.");
  };

  if (status === "loading" || loading) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-muted">Loading movies...</p>
      </div>
    );
  }

  const currentRating = currentMovie ? ratings.get(currentMovie.id) : null;
  const ratedMoviesSearchTerm = ratedMoviesSearch.trim().toLowerCase();
  const filteredRatedMovies = ratedMovies.filter((entry) => {
    if (!ratedMoviesSearchTerm) return true;
    const title = entry.movie.title.toLowerCase();
    const year = entry.movie.year ? String(entry.movie.year) : "";
    return title.includes(ratedMoviesSearchTerm) || year.includes(ratedMoviesSearchTerm);
  });

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
          onFeedback={() => void submitRecommendationFeedback(currentMovie)}
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

      <div className="bg-card border border-border rounded-xl p-3 space-y-3">
        <button
          onClick={() => setShowRatedMovies((prev) => !prev)}
          className="w-full flex items-center justify-between text-left"
        >
          <div>
            <p className="text-sm font-semibold">Rated Movies</p>
            <p className="text-[11px] text-muted">
              Review and edit scores plus seen status.
            </p>
          </div>
          <span className="text-xs text-muted">{ratedMovies.length} total</span>
        </button>

        {showRatedMovies && (
          <div className="space-y-2">
            <Input
              placeholder="Search rated movies by title or year..."
              value={ratedMoviesSearch}
              onChange={(e) => setRatedMoviesSearch(e.target.value)}
            />
            <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
            {ratedMovies.length === 0 ? (
              <p className="text-xs text-muted py-2">No rated movies yet.</p>
            ) : filteredRatedMovies.length === 0 ? (
              <p className="text-xs text-muted py-2">No rated movies match your search.</p>
            ) : (
              filteredRatedMovies.map((entry) => (
                <div
                  key={entry.id}
                  className="bg-card-hover border border-border rounded-lg p-2.5 space-y-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium leading-tight">
                        {entry.movie.title}
                      </p>
                      {entry.movie.year ? (
                        <p className="text-[11px] text-muted">{entry.movie.year}</p>
                      ) : null}
                    </div>
                    {updatingRatedMovieId === entry.movieId ? (
                      <span className="text-[10px] text-muted">Saving...</span>
                    ) : null}
                  </div>

                  <div className="flex items-center gap-1">
                    {[1, 2, 3, 4, 5].map((value) => (
                      <button
                        key={value}
                        onClick={() =>
                          void updateRatedMovie(entry, { rating: value, notHeardOf: false })
                        }
                        className={`w-7 h-7 rounded-md text-sm transition-all ${
                          (entry.rating ?? 0) >= value && !entry.notHeardOf
                            ? "bg-accent text-white"
                            : "bg-card border border-border text-muted hover:text-foreground"
                        }`}
                        aria-label={`Rate ${value} stars`}
                      >
                        ★
                      </button>
                    ))}
                    <button
                      onClick={() => void updateRatedMovie(entry, { notHeardOf: true })}
                      className={`ml-1 text-[10px] px-2 py-1 rounded-md border transition-all ${
                        entry.notHeardOf
                          ? "bg-accent/10 text-accent border-accent/40"
                          : "bg-card border-border text-muted hover:text-foreground"
                      }`}
                    >
                      Not heard of
                    </button>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => void updateRatedMovie(entry, { hasSeen: false })}
                      disabled={entry.notHeardOf || entry.rating === null}
                      className={`px-2.5 py-1 text-[10px] rounded-md border transition-all ${
                        !entry.hasSeen && !entry.notHeardOf
                          ? "bg-accent text-white border-accent"
                          : "bg-card text-muted border-border"
                      } disabled:opacity-40`}
                    >
                      Unseen
                    </button>
                    <button
                      onClick={() => void updateRatedMovie(entry, { hasSeen: true })}
                      disabled={entry.notHeardOf || entry.rating === null}
                      className={`px-2.5 py-1 text-[10px] rounded-md border transition-all ${
                        entry.hasSeen && !entry.notHeardOf
                          ? "bg-accent text-white border-accent"
                          : "bg-card text-muted border-border"
                      } disabled:opacity-40`}
                    >
                      Seen
                    </button>
                  </div>
                </div>
              ))
            )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

