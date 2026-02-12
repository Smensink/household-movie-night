"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import Input from "@/components/ui/Input";
import StarRating from "@/components/StarRating";

const LAST_RATE_PATH_KEY = "lastRatePath";

type Tab = "movies" | "people" | "studios";

interface MovieResult {
  id: string;
  title: string;
  year: number | null;
  posterUrl: string | null;
  imdbRating: number | null;
  directors: string[];
}

interface PersonResult {
  id: string;
  name: string;
  photoUrl: string | null;
  knownFor: string | null;
}

interface StudioResult {
  id: string;
  name: string;
}

interface MovieRatingState {
  rating: number | null;
  hasSeen: boolean;
}

interface PersonRatingState {
  actorRating: number | null;
  directorRating: number | null;
}

interface StudioRatingState {
  rating: number | null;
}

export default function SearchPage() {
  const { status } = useSession();
  const router = useRouter();

  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<Tab>("movies");
  const [loading, setLoading] = useState(false);

  // Results
  const [movieResults, setMovieResults] = useState<MovieResult[]>([]);
  const [peopleResults, setPeopleResults] = useState<PersonResult[]>([]);
  const [allStudios, setAllStudios] = useState<StudioResult[]>([]);

  // User ratings maps
  const [movieRatings, setMovieRatings] = useState<
    Record<string, MovieRatingState>
  >({});
  const [peopleRatings, setPeopleRatings] = useState<
    Record<string, PersonRatingState>
  >({});
  const [studioRatings, setStudioRatings] = useState<
    Record<string, StudioRatingState>
  >({});

  const searchRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  useEffect(() => {
    if (status !== "authenticated") return;
    if (typeof window === "undefined") return;
    localStorage.setItem(LAST_RATE_PATH_KEY, "/preferences/search");
  }, [status]);

  // Load existing ratings on mount
  useEffect(() => {
    if (status !== "authenticated") return;

    fetch("/api/ratings")
      .then((r) => r.json())
      .then((data) => {
        if (!Array.isArray(data)) return;
        const map: Record<string, MovieRatingState> = {};
        for (const r of data) {
          map[r.movieId] = { rating: r.rating, hasSeen: r.hasSeen };
        }
        setMovieRatings(map);
      });

    fetch("/api/ratings/people")
      .then((r) => r.json())
      .then((data) => {
        const map: Record<string, PersonRatingState> = {};
        for (const r of data.actors || []) {
          if (!map[r.personId]) map[r.personId] = { actorRating: null, directorRating: null };
          map[r.personId].actorRating = r.rating;
        }
        for (const r of data.directors || []) {
          if (!map[r.personId]) map[r.personId] = { actorRating: null, directorRating: null };
          map[r.personId].directorRating = r.rating;
        }
        setPeopleRatings(map);
      });

    fetch("/api/ratings/studios")
      .then((r) => r.json())
      .then((data) => {
        setAllStudios(data.studios || []);
        const map: Record<string, StudioRatingState> = {};
        for (const [id, val] of Object.entries(
          (data.ratings || {}) as Record<
            string,
            { rating: number | null }
          >
        )) {
          map[id] = { rating: val.rating };
        }
        setStudioRatings(map);
      });
  }, [status]);

  // Autofocus
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const doSearch = useCallback(
    async (q: string, tab: Tab) => {
      if (!q || q.length < 2) {
        if (tab === "movies") setMovieResults([]);
        if (tab === "people") setPeopleResults([]);
        return;
      }

      setLoading(true);
      try {
        if (tab === "movies") {
          const res = await fetch(
            `/api/movies/search?q=${encodeURIComponent(q)}`
          );
          const data = await res.json();
          setMovieResults(Array.isArray(data) ? data : []);
        } else if (tab === "people") {
          const res = await fetch(
            `/api/people/search?q=${encodeURIComponent(q)}`
          );
          const data = await res.json();
          setPeopleResults(Array.isArray(data) ? data : []);
        }
        // Studios are filtered client-side, no API call
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const handleQueryChange = useCallback(
    (value: string) => {
      setQuery(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        doSearch(value, activeTab);
      }, 300);
    },
    [activeTab, doSearch]
  );

  const handleTabChange = useCallback(
    (tab: Tab) => {
      setActiveTab(tab);
      if (query.length >= 2) {
        doSearch(query, tab);
      }
    },
    [query, doSearch]
  );

  // --- Rating handlers ---

  const rateMovie = useCallback(
    (movieId: string, rating: number, hasSeen?: boolean) => {
      const prev = movieRatings[movieId];
      const seen = hasSeen !== undefined ? hasSeen : prev?.hasSeen ?? false;
      setMovieRatings((m) => ({
        ...m,
        [movieId]: { rating, hasSeen: seen },
      }));
      fetch("/api/ratings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ movieId, rating, hasSeen: seen }),
      });
    },
    [movieRatings]
  );

  const toggleSeen = useCallback(
    (movieId: string) => {
      const prev = movieRatings[movieId];
      const newSeen = !(prev?.hasSeen ?? false);
      const rating = prev?.rating ?? null;
      setMovieRatings((m) => ({
        ...m,
        [movieId]: { rating, hasSeen: newSeen },
      }));
      if (rating !== null) {
        fetch("/api/ratings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ movieId, rating, hasSeen: newSeen }),
        });
      }
    },
    [movieRatings]
  );

  const ratePerson = useCallback(
    (personId: string, rating: number, type: "actor" | "director") => {
      setPeopleRatings((m) => {
        const prev = m[personId] || { actorRating: null, directorRating: null };
        return {
          ...m,
          [personId]:
            type === "actor"
              ? { ...prev, actorRating: rating }
              : { ...prev, directorRating: rating },
        };
      });
      fetch("/api/ratings/people", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personId, type, rating }),
      });
    },
    []
  );

  const rateStudio = useCallback((studioId: string, rating: number) => {
    setStudioRatings((m) => ({ ...m, [studioId]: { rating } }));
    fetch("/api/ratings/studios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studioId, rating }),
    });
  }, []);

  // Filtered studios (client-side)
  const filteredStudios =
    query.length >= 2
      ? allStudios.filter((s) =>
          s.name.toLowerCase().includes(query.toLowerCase())
        )
      : allStudios;

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "movies", label: "Movies" },
    { key: "people", label: "People" },
    { key: "studios", label: "Studios" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/preferences"
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-card transition-colors"
        >
          <svg
            className="w-5 h-5 text-muted"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
        </Link>
        <div>
          <h1 className="text-2xl font-bold">Search & Rate</h1>
          <p className="text-sm text-muted mt-0.5">
            Find and rate movies, people, or studios
          </p>
        </div>
      </div>

      <Input
        ref={searchRef}
        placeholder="Search movies, people, or studios..."
        value={query}
        onChange={(e) => handleQueryChange(e.target.value)}
      />

      {/* Tabs */}
      <div className="flex gap-1 bg-card border border-border rounded-xl p-1">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => handleTabChange(tab.key)}
            className={`flex-1 text-sm font-medium py-2 rounded-lg transition-all ${
              activeTab === tab.key
                ? "bg-accent text-white"
                : "text-muted hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="bg-card border border-border rounded-xl p-4 animate-pulse"
            >
              <div className="flex gap-3">
                <div className="w-12 h-16 bg-border rounded-lg" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-border rounded w-3/4" />
                  <div className="h-3 bg-border rounded w-1/2" />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Movie results */}
      {!loading && activeTab === "movies" && (
        <div className="space-y-2">
          {movieResults.length === 0 && query.length >= 2 && (
            <p className="text-sm text-muted text-center py-8">
              No movies found for &ldquo;{query}&rdquo;
            </p>
          )}
          {movieResults.map((movie) => {
            const mr = movieRatings[movie.id];
            return (
              <div
                key={movie.id}
                className="bg-card border border-border rounded-xl p-3 flex gap-3 items-start"
              >
                {movie.posterUrl ? (
                  <Image
                    src={movie.posterUrl}
                    alt={movie.title}
                    width={48}
                    height={72}
                    className="rounded-lg object-cover flex-shrink-0"
                  />
                ) : (
                  <div className="w-12 h-[72px] bg-border rounded-lg flex-shrink-0 flex items-center justify-center">
                    <svg
                      className="w-5 h-5 text-muted"
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
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="font-semibold text-sm truncate">
                      {movie.title}
                    </span>
                    {movie.year && (
                      <span className="text-xs text-muted flex-shrink-0">
                        ({movie.year})
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-muted">
                    {movie.directors.length > 0 && (
                      <span>Dir: {movie.directors.join(", ")}</span>
                    )}
                    {movie.imdbRating && (
                      <span className="flex items-center gap-0.5">
                        <svg
                          className="w-3 h-3"
                          viewBox="0 0 24 24"
                          fill="var(--star)"
                        >
                          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                        </svg>
                        {movie.imdbRating}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-2">
                    <button
                      onClick={() => toggleSeen(movie.id)}
                      className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                        mr?.hasSeen
                          ? "bg-accent/10 border-accent/30 text-accent"
                          : "border-border text-muted hover:border-accent/30"
                      }`}
                    >
                      {mr?.hasSeen ? "Seen" : "Unseen"}
                    </button>
                    <StarRating
                      rating={mr?.rating ?? null}
                      onChange={(r) => rateMovie(movie.id, r)}
                      size="sm"
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* People results */}
      {!loading && activeTab === "people" && (
        <div className="space-y-2">
          {peopleResults.length === 0 && query.length >= 2 && (
            <p className="text-sm text-muted text-center py-8">
              No people found for &ldquo;{query}&rdquo;
            </p>
          )}
          {peopleResults.map((person) => {
            const pr = peopleRatings[person.id];
            return (
              <div
                key={person.id}
                className="bg-card border border-border rounded-xl p-3 flex gap-3 items-start"
              >
                {person.photoUrl ? (
                  <Image
                    src={person.photoUrl}
                    alt={person.name}
                    width={48}
                    height={48}
                    className="rounded-full object-cover flex-shrink-0"
                  />
                ) : (
                  <div className="w-12 h-12 bg-border rounded-full flex-shrink-0 flex items-center justify-center">
                    <svg
                      className="w-5 h-5 text-muted"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                      />
                    </svg>
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-sm">{person.name}</div>
                  {person.knownFor && (
                    <div className="text-xs text-muted mt-0.5">
                      Known for: {person.knownFor}
                    </div>
                  )}
                  <div className="space-y-1.5 mt-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted w-14">Actor</span>
                      <StarRating
                        rating={pr?.actorRating ?? null}
                        onChange={(r) => ratePerson(person.id, r, "actor")}
                        size="sm"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted w-14">Director</span>
                      <StarRating
                        rating={pr?.directorRating ?? null}
                        onChange={(r) => ratePerson(person.id, r, "director")}
                        size="sm"
                      />
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Studio results */}
      {!loading && activeTab === "studios" && (
        <div className="space-y-2">
          {filteredStudios.length === 0 && query.length >= 2 && (
            <p className="text-sm text-muted text-center py-8">
              No studios found for &ldquo;{query}&rdquo;
            </p>
          )}
          {filteredStudios.map((studio) => {
            const sr = studioRatings[studio.id];
            return (
              <div
                key={studio.id}
                className="bg-card border border-border rounded-xl p-3 flex items-center gap-3"
              >
                <div className="w-10 h-10 bg-border rounded-lg flex-shrink-0 flex items-center justify-center">
                  <svg
                    className="w-5 h-5 text-muted"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M3 7h18M5 7v11a2 2 0 002 2h10a2 2 0 002-2V7M9 11h6M9 15h4"
                    />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-sm">{studio.name}</div>
                </div>
                <StarRating
                  rating={sr?.rating ?? null}
                  onChange={(r) => rateStudio(studio.id, r)}
                  size="sm"
                />
              </div>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {!loading && query.length < 2 && activeTab !== "studios" && (
        <p className="text-sm text-muted text-center py-8">
          Type at least 2 characters to search
        </p>
      )}
    </div>
  );
}
