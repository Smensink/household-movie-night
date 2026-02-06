"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import StarRating from "@/components/StarRating";
import Input from "@/components/ui/Input";
import Button from "@/components/ui/Button";

interface Person {
  id: string;
  name: string;
  photoUrl?: string | null;
  knownFor?: string | null;
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
  return `${type}:${personId.trim().toLowerCase()}`;
}

export default function RatePeoplePage() {
  const { status } = useSession();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [ratings, setRatings] = useState<Map<string, PersonRating>>(new Map());
  const [searching, setSearching] = useState(false);
  const [activeTab, setActiveTab] = useState<"actor" | "director">("actor");

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  useEffect(() => {
    if (status !== "authenticated") return;
    fetch("/api/ratings/people")
      .then((r) => r.json())
      .then((data) => {
        const next = new Map<string, PersonRating>();
        if (Array.isArray(data?.actors)) {
          for (const rating of data.actors) {
            const personLookupId =
              typeof rating?.person?.name === "string"
                ? rating.person.name
                : rating?.personId;
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
              typeof rating?.person?.name === "string"
                ? rating.person.name
                : rating?.personId;
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
  }, [status]);

  const searchPeople = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    // Use movie search and extract people from cast/crew
    const res = await fetch(
      `/api/movies/search?q=${encodeURIComponent(searchQuery)}`
    );
    const movies: SearchMovieResult[] = await res.json();
    const uniquePeople: Person[] = [];
    const seen = new Set<string>();
    for (const movie of movies) {
      const candidates =
        activeTab === "director" ? movie.directors || [] : movie.actors || [];

      for (const candidate of candidates) {
        const name = candidate.trim();
        const dedupeKey = name.toLowerCase();
        if (!name || seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        uniquePeople.push({
          id: name,
          name,
          knownFor: activeTab === "director" ? "directing" : "acting",
        });
      }
    }
    setPeople(uniquePeople);
    setSearching(false);
  };

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

    await fetch("/api/ratings/people", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personId, personName, type, rating, notHeardOf }),
    });
  };

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Rate People</h1>
        <p className="text-sm text-muted mt-1">
          Rate actors and directors to improve recommendations
        </p>
      </div>

      {/* Tabs */}
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

      {/* Search */}
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

      {/* People list */}
      <div className="space-y-2">
        {people.map((person) => {
          const ratingKey = getRatingKey(person.id, activeTab);
          const r = ratings.get(ratingKey);
          return (
            <div
              key={person.id}
              className="bg-card border border-border rounded-xl p-4 animate-slide-up"
            >
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h3 className="text-sm font-semibold">{person.name}</h3>
                  {person.knownFor && (
                    <span className="text-[11px] text-muted capitalize">
                      {person.knownFor}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <StarRating
                  rating={r?.rating ?? null}
                  onChange={(rating) =>
                    ratePerson(person.id, person.name, activeTab, rating)
                  }
                  size="sm"
                />
                <button
                  onClick={() =>
                    ratePerson(person.id, person.name, activeTab, null, true)
                  }
                  className={`text-[11px] px-2 py-1 rounded-lg transition-all ${
                    r?.notHeardOf
                      ? "bg-warning/15 text-warning border border-warning/30"
                      : "bg-card-hover text-muted border border-border hover:text-foreground"
                  }`}
                >
                  {r?.notHeardOf ? "Haven't heard of them" : "Don't know them"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {people.length === 0 && (
        <div className="text-center py-12">
          <p className="text-sm text-muted">
            Search for {activeTab}s to rate them
          </p>
        </div>
      )}
    </div>
  );
}
