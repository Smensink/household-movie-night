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

interface PersonRating {
  personId: string;
  rating: number | null;
  notHeardOf: boolean;
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

  const searchPeople = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    // Use movie search and extract people from cast/crew
    const res = await fetch(
      `/api/movies/search?q=${encodeURIComponent(searchQuery)}`
    );
    const movies = await res.json();
    // For now, show the search results as a proxy
    // In a full implementation, you'd have a dedicated people search API
    const uniquePeople: Person[] = [];
    const seen = new Set<string>();
    for (const movie of movies) {
      if (movie.director && !seen.has(movie.director)) {
        seen.add(movie.director);
        uniquePeople.push({
          id: movie.director,
          name: movie.director,
          knownFor: "directing",
        });
      }
    }
    setPeople(uniquePeople);
    setSearching(false);
  };

  const ratePerson = async (
    personId: string,
    type: "actor" | "director",
    rating: number | null,
    notHeardOf: boolean = false
  ) => {
    setRatings((prev) => {
      const next = new Map(prev);
      next.set(personId, { personId, rating, notHeardOf });
      return next;
    });

    await fetch("/api/ratings/people", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personId, type, rating, notHeardOf }),
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
          const r = ratings.get(person.id);
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
                    ratePerson(person.id, activeTab, rating)
                  }
                  size="sm"
                />
                <button
                  onClick={() => ratePerson(person.id, activeTab, null, true)}
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
