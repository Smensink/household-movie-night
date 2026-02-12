"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import GenreRanker from "@/components/GenreRanker";
import Link from "next/link";

interface Genre {
  id: string;
  name: string;
  slug: string;
}

export default function GenrePreferencesPage() {
  const { status } = useSession();
  const router = useRouter();
  const [genres, setGenres] = useState<Genre[]>([]);
  const [rankings, setRankings] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
    }
  }, [status, router]);

  useEffect(() => {
    if (status !== "authenticated") return;

    fetch("/api/genres")
      .then((r) => r.json())
      .then((data) => {
        setGenres(data.genres || []);
        setRankings(data.rankings || {});
      })
      .finally(() => setLoading(false));
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

  if (status === "loading" || loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Rank Genres</h1>
          <p className="text-sm text-muted mt-1">
            Order genres from favorite to least favorite.
          </p>
        </div>
        <Link href="/preferences" className="text-xs text-accent hover:underline">
          Back
        </Link>
      </div>

      {saved && (
        <div className="bg-success/10 border border-success/20 text-success text-sm px-4 py-2 rounded-xl animate-slide-up">
          Genre rankings saved.
        </div>
      )}

      {genres.length > 0 ? (
        <GenreRanker
          genres={genres}
          initialRankings={rankings}
          onSave={handleSaveGenres}
          saving={saving}
        />
      ) : (
        <div className="bg-card border border-border rounded-xl p-4 text-sm text-muted">
          No genres available yet. Refresh this page and try again.
        </div>
      )}
    </div>
  );
}
