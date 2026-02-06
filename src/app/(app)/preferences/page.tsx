"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import GenreRanker from "@/components/GenreRanker";

interface Genre {
  id: string;
  name: string;
  slug: string;
}

export default function PreferencesPage() {
  const { status } = useSession();
  const router = useRouter();
  const [genres, setGenres] = useState<Genre[]>([]);
  const [rankings, setRankings] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [ratingCount, setRatingCount] = useState(0);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  useEffect(() => {
    if (status === "authenticated") {
      fetch("/api/genres")
        .then((r) => r.json())
        .then((data) => {
          setGenres(data.genres || []);
          setRankings(data.rankings || {});
        });
      fetch("/api/ratings")
        .then((r) => r.json())
        .then((data) => setRatingCount(Array.isArray(data) ? data.length : 0));
    }
  }, [status]);

  const handleSaveGenres = async (
    newRankings: { genreId: string; rank: number }[]
  ) => {
    setSaving(true);
    await fetch("/api/genres", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rankings: newRankings }),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Your Preferences</h1>
        <p className="text-sm text-muted mt-1">
          Help us find movies you&apos;ll love
        </p>
      </div>

      {saved && (
        <div className="bg-success/10 border border-success/20 text-success text-sm px-4 py-2 rounded-xl animate-slide-up">
          Rankings saved!
        </div>
      )}

      {/* Quick stats */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-2xl font-bold text-accent">{ratingCount}</div>
          <div className="text-xs text-muted">Movies rated</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-2xl font-bold text-accent">
            {Object.keys(rankings).length}
          </div>
          <div className="text-xs text-muted">Genres ranked</div>
        </div>
      </div>

      {/* Nav links to sub-sections */}
      <div className="space-y-2">
        <Link
          href="/preferences/movies"
          className="flex items-center justify-between bg-card border border-border rounded-xl p-4 hover:border-accent/30 transition-all"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-accent-soft rounded-xl flex items-center justify-center">
              <svg className="w-5 h-5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" />
              </svg>
            </div>
            <div>
              <div className="text-sm font-semibold">Rate Movies</div>
              <div className="text-[11px] text-muted">Discover and rate movies</div>
            </div>
          </div>
          <svg className="w-5 h-5 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/preferences/people"
          className="flex items-center justify-between bg-card border border-border rounded-xl p-4 hover:border-accent/30 transition-all"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-accent-soft rounded-xl flex items-center justify-center">
              <svg className="w-5 h-5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <div>
              <div className="text-sm font-semibold">Rate People</div>
              <div className="text-[11px] text-muted">Rate actors & directors</div>
            </div>
          </div>
          <svg className="w-5 h-5 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>
      </div>

      {/* Genre Rankings */}
      {genres.length > 0 && (
        <GenreRanker
          genres={genres}
          initialRankings={rankings}
          onSave={handleSaveGenres}
          saving={saving}
        />
      )}
    </div>
  );
}
