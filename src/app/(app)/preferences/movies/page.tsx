"use client";

import { useEffect, useState, useCallback } from "react";
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
}

interface UserRating {
  movieId: string;
  rating: number | null;
  hasSeen: boolean;
  notHeardOf: boolean;
}

export default function RateMoviesPage() {
  const { status } = useSession();
  const router = useRouter();
  const [movies, setMovies] = useState<Movie[]>([]);
  const [ratings, setRatings] = useState<Map<string, UserRating>>(new Map());
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [mode, setMode] = useState<"discover" | "search">("discover");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  // Load discover movies and existing ratings
  useEffect(() => {
    if (status !== "authenticated") return;

    Promise.all([
      fetch("/api/movies/discover").then((r) => r.json()),
      fetch("/api/ratings").then((r) => r.json()),
    ]).then(([discoverMovies, userRatings]) => {
      setMovies(discoverMovies);
      const ratingMap = new Map<string, UserRating>();
      if (Array.isArray(userRatings)) {
        for (const r of userRatings) {
          ratingMap.set(r.movieId, r);
        }
      }
      setRatings(ratingMap);
      setLoading(false);
    });
  }, [status]);

  const searchMovies = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setMode("search");
    const res = await fetch(
      `/api/movies/search?q=${encodeURIComponent(searchQuery)}`
    );
    const data = await res.json();
    setMovies(data);
    setSearching(false);
  }, [searchQuery]);

  const rateMovie = async (
    movieId: string,
    rating: number | null,
    hasSeen?: boolean,
    notHeardOf?: boolean
  ) => {
    const existing = ratings.get(movieId);
    const payload = {
      movieId,
      rating: notHeardOf ? null : rating,
      hasSeen: hasSeen ?? existing?.hasSeen ?? false,
      notHeardOf: notHeardOf ?? false,
    };

    // Optimistic update
    setRatings((prev) => {
      const next = new Map(prev);
      next.set(movieId, payload);
      return next;
    });

    await fetch("/api/ratings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  };

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
          Search or discover movies to rate. If you haven&apos;t seen a movie, your rating represents willingness to watch.
        </p>
      </div>

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
            setMode("discover");
            setSearchQuery("");
            fetch("/api/movies/discover")
              .then((r) => r.json())
              .then(setMovies);
          }}
          className="text-xs text-accent hover:underline"
        >
          Back to discover
        </button>
      )}

      {/* Movie list */}
      <div className="space-y-3">
        {movies.map((movie) => {
          const r = ratings.get(movie.id);
          return (
            <MovieCard
              key={movie.id}
              movie={movie}
              rating={r?.rating ?? null}
              hasSeen={r?.hasSeen ?? false}
              onRate={(rating) => rateMovie(movie.id, rating, r?.hasSeen)}
              onSeenToggle={(seen) =>
                rateMovie(movie.id, r?.rating ?? null, seen)
              }
              onNotHeardOf={() => rateMovie(movie.id, null, false, true)}
            />
          );
        })}
      </div>

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
