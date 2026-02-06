"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import MovieCard from "@/components/MovieCard";
import Input from "@/components/ui/Input";
import Button from "@/components/ui/Button";

interface Movie {
  id: string;
  title: string;
  year?: number | null;
  posterUrl?: string | null;
  overview?: string | null;
  era?: string | null;
  imdbId?: string;
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
  removedIndex: number;
  previousRating: UserRating | null;
  hadPreviousRating: boolean;
  replacementMovie: Movie | null;
}

const DISCOVER_VISIBLE_COUNT = 12;
const DISCOVER_INITIAL_BATCH = 24;
const DISCOVER_QUEUE_TARGET = 6;
const DISCOVER_REFILL_BATCH = 12;

function dedupeMoviesById(movies: Movie[]): Movie[] {
  const seen = new Set<string>();
  const deduped: Movie[] = [];

  for (const movie of movies) {
    if (seen.has(movie.id)) continue;
    seen.add(movie.id);
    deduped.push(movie);
  }

  return deduped;
}

export default function RateMoviesPage() {
  const { status } = useSession();
  const router = useRouter();

  const [movies, setMovies] = useState<Movie[]>([]);
  const [discoverQueue, setDiscoverQueue] = useState<Movie[]>([]);
  const [ratings, setRatings] = useState<Map<string, UserRating>>(new Map());
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [mode, setMode] = useState<"discover" | "search">("discover");
  const [loading, setLoading] = useState(true);
  const [undoAction, setUndoAction] = useState<UndoAction | null>(null);

  const moviesRef = useRef<Movie[]>([]);
  const queueRef = useRef<Movie[]>([]);
  const ratingsRef = useRef<Map<string, UserRating>>(new Map());
  const queueLoadingRef = useRef(false);

  const setMoviesAndRef = useCallback((nextMovies: Movie[]) => {
    moviesRef.current = nextMovies;
    setMovies(nextMovies);
  }, []);

  const setQueueAndRef = useCallback((nextQueue: Movie[]) => {
    queueRef.current = nextQueue;
    setDiscoverQueue(nextQueue);
  }, []);

  useEffect(() => {
    moviesRef.current = movies;
  }, [movies]);

  useEffect(() => {
    queueRef.current = discoverQueue;
  }, [discoverQueue]);

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

  const getExcludeMovieIds = useCallback((extraIds: string[] = []) => {
    return Array.from(
      new Set([
        ...moviesRef.current.map((movie) => movie.id),
        ...queueRef.current.map((movie) => movie.id),
        ...extraIds,
      ])
    );
  }, []);

  const refillDiscoverQueue = useCallback(async () => {
    if (status !== "authenticated" || mode !== "discover") return;
    if (queueLoadingRef.current) return;
    if (queueRef.current.length >= DISCOVER_QUEUE_TARGET) return;

    queueLoadingRef.current = true;
    try {
      const batch = await fetchDiscoverBatch(
        DISCOVER_REFILL_BATCH,
        getExcludeMovieIds()
      );
      if (batch.length === 0) return;

      const merged = dedupeMoviesById([...queueRef.current, ...batch]);
      setQueueAndRef(merged);
    } finally {
      queueLoadingRef.current = false;
    }
  }, [fetchDiscoverBatch, getExcludeMovieIds, mode, setQueueAndRef, status]);

  const loadDiscoverMovies = useCallback(async () => {
    const discoverMovies = await fetchDiscoverBatch(DISCOVER_INITIAL_BATCH, []);
    const visible = discoverMovies.slice(0, DISCOVER_VISIBLE_COUNT);
    const queued = discoverMovies.slice(DISCOVER_VISIBLE_COUNT);

    setMoviesAndRef(visible);
    setQueueAndRef(queued);
    setMode("discover");
    setUndoAction(null);
    void refillDiscoverQueue();
  }, [fetchDiscoverBatch, refillDiscoverQueue, setMoviesAndRef, setQueueAndRef]);

  useEffect(() => {
    if (status !== "authenticated") return;

    let cancelled = false;

    Promise.all([
      fetchDiscoverBatch(DISCOVER_INITIAL_BATCH, []),
      fetch("/api/ratings").then((r) => r.json()),
    ])
      .then(([discoverMovies, userRatings]) => {
        if (cancelled) return;

        const visible = discoverMovies.slice(0, DISCOVER_VISIBLE_COUNT);
        const queued = discoverMovies.slice(DISCOVER_VISIBLE_COUNT);

        setMoviesAndRef(visible);
        setQueueAndRef(queued);

        const ratingMap = new Map<string, UserRating>();
        if (Array.isArray(userRatings)) {
          for (const rating of userRatings) {
            ratingMap.set(rating.movieId, rating);
          }
        }

        ratingsRef.current = ratingMap;
        setRatings(ratingMap);
        setLoading(false);
        void refillDiscoverQueue();
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [fetchDiscoverBatch, refillDiscoverQueue, setMoviesAndRef, setQueueAndRef, status]);

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
    setMoviesAndRef(nextMovies);

    setSearching(false);
  }, [searchQuery, setMoviesAndRef]);

  const pullReplacementMovie = useCallback(async (): Promise<Movie | null> => {
    if (queueRef.current.length > 0) {
      const [nextMovie, ...remainingQueue] = queueRef.current;
      setQueueAndRef(remainingQueue);
      return nextMovie;
    }

    const batch = await fetchDiscoverBatch(
      DISCOVER_REFILL_BATCH,
      getExcludeMovieIds()
    );
    if (batch.length === 0) return null;

    const [nextMovie, ...remainingQueue] = batch;
    setQueueAndRef(remainingQueue);
    return nextMovie;
  }, [fetchDiscoverBatch, getExcludeMovieIds, setQueueAndRef]);

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
    notHeardOf?: boolean,
    advanceOnRate: boolean = false
  ) => {
    const existing = ratingsRef.current.get(movieId);
    const payload: UserRating = {
      movieId,
      rating: notHeardOf ? null : rating,
      hasSeen: notHeardOf ? false : hasSeen ?? existing?.hasSeen ?? false,
      notHeardOf: notHeardOf ?? false,
    };

    setRatings((prev) => {
      const next = new Map(prev);
      next.set(movieId, payload);
      ratingsRef.current = next;
      return next;
    });

    let removedMovie: Movie | null = null;
    let removedIndex = -1;
    let replacementMovie: Movie | null = null;

    if (mode === "discover" && advanceOnRate) {
      const currentMovies = moviesRef.current;
      removedIndex = currentMovies.findIndex((movie) => movie.id === movieId);
      if (removedIndex >= 0) {
        removedMovie = currentMovies[removedIndex];
        const trimmed = [
          ...currentMovies.slice(0, removedIndex),
          ...currentMovies.slice(removedIndex + 1),
        ];
        setMoviesAndRef(trimmed);

        replacementMovie = await pullReplacementMovie();
        if (replacementMovie) {
          setMoviesAndRef([...moviesRef.current, replacementMovie]);
        }

        setUndoAction({
          movie: removedMovie,
          removedIndex,
          previousRating: existing ?? null,
          hadPreviousRating: existing !== undefined,
          replacementMovie,
        });

        void refillDiscoverQueue();
      }
    }

    await persistRating(payload);
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
      }
      ratingsRef.current = next;
      return next;
    });

    const withoutDuplicates = moviesRef.current.filter(
      (movie) => movie.id !== action.movie.id && movie.id !== action.replacementMovie?.id
    );
    const insertIndex = Math.max(0, Math.min(action.removedIndex, withoutDuplicates.length));
    const restored = [...withoutDuplicates];
    restored.splice(insertIndex, 0, action.movie);
    setMoviesAndRef(restored);

    if (action.replacementMovie) {
      const nextQueue = dedupeMoviesById([action.replacementMovie, ...queueRef.current]);
      setQueueAndRef(nextQueue);
    }

    if (action.hadPreviousRating && action.previousRating) {
      await persistRating(action.previousRating);
    } else {
      await fetch(`/api/ratings?movieId=${encodeURIComponent(action.movie.id)}`, {
        method: "DELETE",
      });
    }
  }, [persistRating, setMoviesAndRef, setQueueAndRef, undoAction]);

  if (status === "loading" || loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Rate Movies</h1>
        <p className="text-sm text-muted mt-1">
          Search or discover movies to rate. If you haven&apos;t seen a movie, your rating means willingness to watch it.
        </p>
      </div>

      {undoAction && (
        <div className="bg-card border border-border rounded-xl p-3 flex items-center justify-between gap-3">
          <p className="text-xs text-muted">
            Rated <span className="text-foreground font-medium">{undoAction.movie.title}</span>. Undo?
          </p>
          <button
            onClick={undoLastRating}
            className="text-xs text-accent font-medium hover:underline"
          >
            Undo
          </button>
        </div>
      )}

      {/* Search */}
      <div className="flex gap-2">
        <Input
          placeholder="Search movies..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && searchMovies()}
        />
        <Button onClick={searchMovies} loading={searching}>
          Search
        </Button>
      </div>

      {mode === "search" && (
        <button
          onClick={() => {
            setSearchQuery("");
            void loadDiscoverMovies();
          }}
          className="text-xs text-accent hover:underline"
        >
          Back to discover
        </button>
      )}

      {/* Movie list */}
      {movies.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between text-xs text-muted">
            <span>
              {mode === "discover"
                ? "Swipe-style queue"
                : `Search results (${movies.length})`}
            </span>
            <span>{mode === "discover" ? `${discoverQueue.length} queued` : ""}</span>
          </div>

          <div className="max-w-4xl mx-auto">
            {(() => {
              const movie = movies[0];
              const rating = ratings.get(movie.id);
              return (
                <MovieCard
                  key={movie.id}
                  movie={movie}
                  rating={rating?.rating ?? null}
                  hasSeen={rating?.hasSeen ?? false}
                  onRate={(value) =>
                    rateMovie(movie.id, value, rating?.hasSeen ?? false, false, true)
                  }
                  onSeenToggle={(seen) => toggleSeen(movie.id, seen)}
                  onNotHeardOf={() => rateMovie(movie.id, null, false, true, true)}
                />
              );
            })()}
          </div>

          {movies.length > 1 && (
            <div className="text-[11px] text-muted text-center">
              {movies.length - 1} more loaded behind this card.
            </div>
          )}
        </div>
      )}

      {movies.length === 0 && !loading && (
        <div className="text-center py-12">
          <p className="text-sm text-muted">
            {mode === "search"
              ? "No results found. Try a different search."
              : "No movies to discover. Configure your Trakt or OMDB API keys in Settings."}
          </p>
        </div>
      )}
    </div>
  );
}
