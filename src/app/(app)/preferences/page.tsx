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
  const [movieRatingCount, setMovieRatingCount] = useState(0);
  const [studioRatingCount, setStudioRatingCount] = useState(0);

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
        .then((data) =>
          setMovieRatingCount(Array.isArray(data) ? data.length : 0)
        );

      fetch("/api/ratings/studios")
        .then((r) => r.json())
        .then((data) => {
          const ratings = data?.ratings || {};
          setStudioRatingCount(Object.keys(ratings).length);
        });
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
          Help us find movies you&apos;ll love.
        </p>
      </div>

      {saved && (
        <div className="bg-success/10 border border-success/20 text-success text-sm px-4 py-2 rounded-xl animate-slide-up">
          Rankings saved.
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-2xl font-bold text-accent">{movieRatingCount}</div>
          <div className="text-xs text-muted">Movies rated</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-2xl font-bold text-accent">{Object.keys(rankings).length}</div>
          <div className="text-xs text-muted">Genres ranked</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4 col-span-2 sm:col-span-1">
          <div className="text-2xl font-bold text-accent">{studioRatingCount}</div>
          <div className="text-xs text-muted">Studios rated</div>
        </div>
      </div>

      <div className="space-y-2">
        <Link
          href="/preferences/genres"
          className="flex items-center justify-between bg-card border border-border rounded-xl p-4 hover:border-accent/30 transition-all"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-accent-soft rounded-xl flex items-center justify-center">
              <svg className="w-5 h-5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 3l14 9-14 9V3z" />
              </svg>
            </div>
            <div>
              <div className="text-sm font-semibold">Rank Genres</div>
              <div className="text-[11px] text-muted">Set your overall genre order</div>
            </div>
          </div>
          <svg className="w-5 h-5 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

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
              <div className="text-[11px] text-muted">Rate actors and directors</div>
            </div>
          </div>
          <svg className="w-5 h-5 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/preferences/studios"
          className="flex items-center justify-between bg-card border border-border rounded-xl p-4 hover:border-accent/30 transition-all"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-accent-soft rounded-xl flex items-center justify-center">
              <svg className="w-5 h-5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7h18M5 7v11a2 2 0 002 2h10a2 2 0 002-2V7M9 11h6M9 15h4" />
              </svg>
            </div>
            <div>
              <div className="text-sm font-semibold">Rate Studios</div>
              <div className="text-[11px] text-muted">Rate production companies</div>
            </div>
          </div>
          <svg className="w-5 h-5 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/preferences/search"
          className="flex items-center justify-between bg-card border border-border rounded-xl p-4 hover:border-accent/30 transition-all"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-accent-soft rounded-xl flex items-center justify-center">
              <svg className="w-5 h-5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <div>
              <div className="text-sm font-semibold">Search & Rate</div>
              <div className="text-[11px] text-muted">Find and rate something specific</div>
            </div>
          </div>
          <svg className="w-5 h-5 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/preferences/upcoming"
          className="flex items-center justify-between bg-card border border-border rounded-xl p-4 hover:border-accent/30 transition-all"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-accent-soft rounded-xl flex items-center justify-center">
              <svg className="w-5 h-5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0zM21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div>
              <div className="text-sm font-semibold">Upcoming Movies</div>
              <div className="text-[11px] text-muted">Vote on anticipated releases for Radarr</div>
            </div>
          </div>
          <svg className="w-5 h-5 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/preferences/radarr-threshold"
          className="flex items-center justify-between bg-card border border-border rounded-xl p-4 hover:border-accent/30 transition-all"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-accent-soft rounded-xl flex items-center justify-center">
              <svg className="w-5 h-5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7h8M7 11h10M10 15h4M4 6a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H8l-4 3V6z" />
              </svg>
            </div>
            <div>
              <div className="text-sm font-semibold">Near Radarr Threshold</div>
              <div className="text-[11px] text-muted">Rate titles close to auto-sync</div>
            </div>
          </div>
          <svg className="w-5 h-5 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/profile"
          className="flex items-center justify-between bg-card border border-border rounded-xl p-4 hover:border-accent/30 transition-all"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-accent-soft rounded-xl flex items-center justify-center">
              <svg className="w-5 h-5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </div>
            <div>
              <div className="text-sm font-semibold">Your Profile</div>
              <div className="text-[11px] text-muted">View what the algorithm learned about you</div>
            </div>
          </div>
          <svg className="w-5 h-5 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>
      </div>

      {genres.length > 0 ? (
        <GenreRanker
          genres={genres}
          initialRankings={rankings}
          onSave={handleSaveGenres}
          saving={saving}
          title="Quick Genre Ranking"
        />
      ) : (
        <div className="bg-card border border-border rounded-xl p-4 text-sm text-muted">
          Genres are loading. You can also use the <Link href="/preferences/genres" className="text-accent hover:underline">full genre ranking page</Link>.
        </div>
      )}
    </div>
  );
}
