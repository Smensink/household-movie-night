"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import StarRating from "@/components/StarRating";
import Input from "@/components/ui/Input";
import Button from "@/components/ui/Button";

interface SampleMovie {
  title: string;
  year?: number | null;
  posterUrl?: string | null;
}

interface Person {
  id: string;
  name: string;
  photoUrl?: string | null;
  knownFor?: string | null;
  sampleMovies?: SampleMovie[];
}

interface SearchMovieResult {
  directors?: string[];
  actors?: string[];
}

interface PersonRating {
  personId: string;
  type: "actor" | "director";
  rating: number | null;
  notHeardOf: boolean;
}

function getRatingKey(personId: string, type: "actor" | "director") {
  return `${type}:${personId}`;
}

function normalizePersonName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function dedupePeopleList(people: Person[]): Person[] {
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const deduped: Person[] = [];

  for (const person of people) {
    const id = person.id?.trim();
    const nameKey = normalizePersonName(person.name || "");
    if (!id || !nameKey) continue;
    if (seenIds.has(id) || seenNames.has(nameKey)) continue;

    seenIds.add(id);
    seenNames.add(nameKey);
    deduped.push(person);
  }

  return deduped;
}

export default function RatePeoplePage() {
  const { status } = useSession();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [ratings, setRatings] = useState<Map<string, PersonRating>>(new Map());
  const [searching, setSearching] = useState(false);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"actor" | "director">("actor");
  const [mode, setMode] = useState<"discover" | "search">("discover");

  const peopleRef = useRef<Person[]>([]);

  const setPeopleAndRef = useCallback((nextPeople: Person[]) => {
    peopleRef.current = nextPeople;
    setPeople(nextPeople);
  }, []);

  useEffect(() => {
    peopleRef.current = people;
  }, [people]);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  const fetchDiscoverPeople = useCallback(
    async (
      type: "actor" | "director",
      limit: number,
      excludeIds: string[] = []
    ): Promise<Person[]> => {
      const params = new URLSearchParams();
      params.set("type", type);
      params.set("limit", String(limit));
      if (excludeIds.length > 0) {
        params.set("excludePersonIds", excludeIds.join(","));
      }

      const res = await fetch(`/api/people/discover?${params.toString()}`);
      if (!res.ok) return [];

      const data = await res.json();
      return Array.isArray(data) ? dedupePeopleList(data as Person[]) : [];
    },
    []
  );

  const loadDiscoverPeople = useCallback(
    async (type: "actor" | "director") => {
      setDiscoverLoading(true);
      setMode("discover");
      const discovered = await fetchDiscoverPeople(type, 16);
      setPeopleAndRef(dedupePeopleList(discovered));
      setDiscoverLoading(false);
    },
    [fetchDiscoverPeople, setPeopleAndRef]
  );

  useEffect(() => {
    if (status !== "authenticated") return;

    fetch("/api/ratings/people")
      .then((r) => r.json())
      .then((data) => {
        const next = new Map<string, PersonRating>();
        if (Array.isArray(data?.actors)) {
          for (const rating of data.actors) {
            const personLookupId =
              rating?.person?.id || rating?.personId || rating?.person?.name;
            if (!personLookupId) continue;
            next.set(getRatingKey(personLookupId, "actor"), {
              personId: personLookupId,
              type: "actor",
              rating: rating.rating ?? null,
              notHeardOf: Boolean(rating.notHeardOf),
            });
          }
        }
        if (Array.isArray(data?.directors)) {
          for (const rating of data.directors) {
            const personLookupId =
              rating?.person?.id || rating?.personId || rating?.person?.name;
            if (!personLookupId) continue;
            next.set(getRatingKey(personLookupId, "director"), {
              personId: personLookupId,
              type: "director",
              rating: rating.rating ?? null,
              notHeardOf: Boolean(rating.notHeardOf),
            });
          }
        }
        setRatings(next);
      });

    const timeoutId = window.setTimeout(() => {
      void loadDiscoverPeople(activeTab);
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activeTab, loadDiscoverPeople, status]);

  const searchPeople = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setMode("search");

    const res = await fetch(`/api/movies/search?q=${encodeURIComponent(searchQuery)}`);
    const movies: SearchMovieResult[] = await res.json();

    const uniquePeople: Person[] = [];
    const seen = new Set<string>();
    for (const movie of movies) {
      const candidates =
        activeTab === "director" ? movie.directors || [] : movie.actors || [];

      for (const candidate of candidates) {
        const name = candidate.trim();
        if (!name) continue;
        const dedupeKey = name.toLowerCase();
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        uniquePeople.push({
          id: name,
          name,
          knownFor: activeTab === "director" ? "directing" : "acting",
          sampleMovies: [],
        });
      }
    }

    setPeopleAndRef(dedupePeopleList(uniquePeople));
    setSearching(false);
  };

  const fetchSingleReplacement = useCallback(
    async (type: "actor" | "director", removedPersonId: string): Promise<Person | null> => {
      const excludeIds = Array.from(
        new Set([...peopleRef.current.map((person) => person.id), removedPersonId])
      );
      const replacement = await fetchDiscoverPeople(type, 1, excludeIds);
      return replacement[0] ?? null;
    },
    [fetchDiscoverPeople]
  );

  const ratePerson = async (
    personId: string,
    personName: string,
    type: "actor" | "director",
    rating: number | null,
    notHeardOf: boolean = false
  ) => {
    const key = getRatingKey(personId, type);
    setRatings((prev) => {
      const next = new Map(prev);
      next.set(key, { personId, type, rating, notHeardOf });
      return next;
    });

    const res = await fetch("/api/ratings/people", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personId, personName, type, rating, notHeardOf }),
    });

    if (res.ok) {
      const saved = await res.json();
      const savedPersonId = saved?.personId || personId;
      setRatings((prev) => {
        const next = new Map(prev);
        next.delete(key);
        next.set(getRatingKey(savedPersonId, type), {
          personId: savedPersonId,
          type,
          rating,
          notHeardOf,
        });
        return next;
      });
    }

    if (mode === "discover") {
      const filtered = peopleRef.current.filter((person) => person.id !== personId);
      setPeopleAndRef(filtered);

      const replacement = await fetchSingleReplacement(type, personId);
      if (replacement) {
        setPeopleAndRef(dedupePeopleList([...peopleRef.current, replacement]));
      }
    }
  };

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const activePerson = people[0];
  const activeRating = activePerson
    ? ratings.get(getRatingKey(activePerson.id, activeTab))
    : undefined;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Rate People</h1>
        <p className="text-sm text-muted mt-1">
          Tinder-style ranking for actors and directors.
        </p>
      </div>

      <div className="flex gap-1 bg-card rounded-xl p-1">
        <button
          onClick={() => setActiveTab("actor")}
          className={`flex-1 text-sm font-medium py-2 rounded-lg transition-all ${
            activeTab === "actor"
              ? "bg-accent text-white"
              : "text-muted hover:text-foreground"
          }`}
        >
          Actors
        </button>
        <button
          onClick={() => setActiveTab("director")}
          className={`flex-1 text-sm font-medium py-2 rounded-lg transition-all ${
            activeTab === "director"
              ? "bg-accent text-white"
              : "text-muted hover:text-foreground"
          }`}
        >
          Directors
        </button>
      </div>

      <div className="flex gap-2">
        <Input
          placeholder={`Search ${activeTab}s...`}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && searchPeople()}
        />
        <Button onClick={searchPeople} loading={searching}>
          Search
        </Button>
      </div>

      {mode === "search" && (
        <button
          onClick={() => {
            setSearchQuery("");
            void loadDiscoverPeople(activeTab);
          }}
          className="text-xs text-accent hover:underline"
        >
          Back to suggestions
        </button>
      )}

      {discoverLoading && mode === "discover" && (
        <div className="text-xs text-muted">Loading suggestions...</div>
      )}

      {activePerson ? (
        <div className="bg-card border border-border rounded-3xl p-5 lg:p-7 animate-slide-up space-y-4">
          <div className="flex items-start gap-4">
            {/* Headshot */}
            <div className="relative w-24 h-32 sm:w-28 sm:h-36 rounded-xl overflow-hidden bg-card-hover flex-shrink-0">
              {activePerson.photoUrl ? (
                <Image
                  src={activePerson.photoUrl}
                  alt={activePerson.name}
                  fill
                  className="object-cover"
                  sizes="112px"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <svg
                    className="w-10 h-10 text-muted"
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
            </div>

            {/* Name and info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-xl sm:text-2xl font-semibold truncate">
                  {activePerson.name}
                </h2>
                <span className="text-[11px] text-muted uppercase tracking-wide flex-shrink-0">
                  {activeTab}
                </span>
              </div>
              {activePerson.knownFor && (
                <p className="text-xs text-muted capitalize mt-1">
                  Known for {activePerson.knownFor}
                </p>
              )}
            </div>
          </div>

          {/* Sample movies with posters */}
          {activePerson.sampleMovies && activePerson.sampleMovies.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-muted">Popular credits</p>
              <div className="flex gap-3 overflow-x-auto pb-2">
                {activePerson.sampleMovies.map((movie) => (
                  <div
                    key={`${activePerson.id}-${movie.title}`}
                    className="flex-shrink-0 w-20"
                  >
                    <div className="relative w-20 h-28 rounded-lg overflow-hidden bg-card-hover border border-border">
                      {movie.posterUrl ? (
                        <Image
                          src={movie.posterUrl}
                          alt={movie.title}
                          fill
                          className="object-cover"
                          sizes="80px"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center p-1">
                          <span className="text-[9px] text-muted text-center line-clamp-3">
                            {movie.title}
                          </span>
                        </div>
                      )}
                    </div>
                    <p className="text-[10px] text-muted mt-1 line-clamp-2 text-center">
                      {movie.title}
                      {movie.year ? ` (${movie.year})` : ""}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="bg-background/30 border border-border rounded-2xl p-4 space-y-2">
            <p className="text-xs text-muted">
              How much do you enjoy movies with this {activeTab}?
            </p>
            <StarRating
              rating={activeRating?.rating ?? null}
              onChange={(value) =>
                ratePerson(activePerson.id, activePerson.name, activeTab, value)
              }
              size="md"
            />
            <button
              onClick={() =>
                ratePerson(activePerson.id, activePerson.name, activeTab, null, true)
              }
              className={`text-xs px-3 py-1.5 rounded-lg transition-all ${
                activeRating?.notHeardOf
                  ? "bg-warning/15 text-warning border border-warning/30"
                  : "bg-card-hover text-muted border border-border hover:text-foreground"
              }`}
            >
              {activeRating?.notHeardOf
                ? "You marked this person as unknown"
                : `I don't know this ${activeTab}`}
            </button>
          </div>

          {people.length > 1 && (
            <p className="text-[11px] text-muted">
              {people.length - 1} more queued.
            </p>
          )}
        </div>
      ) : (
        <div className="text-center py-12">
          <p className="text-sm text-muted">
            {mode === "search"
              ? `No ${activeTab} results found.`
              : `No ${activeTab} suggestions available yet.`}
          </p>
        </div>
      )}
    </div>
  );
}

