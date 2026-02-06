"use client";

import { useMemo, useState } from "react";

interface Genre {
  id: string;
  name: string;
  slug: string;
}

interface GenreRankerProps {
  genres: Genre[];
  initialRankings?: Record<string, number>;
  onSave: (rankings: { genreId: string; rank: number }[]) => void;
  saving?: boolean;
  title?: string;
}

export default function GenreRanker({
  genres,
  initialRankings = {},
  onSave,
  saving,
  title = "Rank Your Genres",
}: GenreRankerProps) {
  const sortedByInitialRank = useMemo(
    () =>
      [...genres].sort((a, b) => {
        const aRank = initialRankings[a.id] ?? Number.POSITIVE_INFINITY;
        const bRank = initialRankings[b.id] ?? Number.POSITIVE_INFINITY;
        if (aRank !== bRank) return aRank - bRank;
        return a.name.localeCompare(b.name);
      }),
    [genres, initialRankings]
  );

  const [selectedGenres, setSelectedGenres] = useState<Genre[]>(
    () => sortedByInitialRank.filter((genre) => initialRankings[genre.id] !== undefined)
  );
  const [availableGenres, setAvailableGenres] = useState<Genre[]>(
    () => sortedByInitialRank.filter((genre) => initialRankings[genre.id] === undefined)
  );

  const selectGenre = (genre: Genre) => {
    setSelectedGenres((prev) => [...prev, genre]);
    setAvailableGenres((prev) => prev.filter((candidate) => candidate.id !== genre.id));
  };

  const unselectGenre = (genre: Genre) => {
    setSelectedGenres((prev) => prev.filter((candidate) => candidate.id !== genre.id));
    setAvailableGenres((prev) =>
      [...prev, genre].sort((a, b) => a.name.localeCompare(b.name))
    );
  };

  const moveGenre = (index: number, direction: -1 | 1) => {
    const destination = index + direction;
    if (destination < 0 || destination >= selectedGenres.length) return;
    const updated = [...selectedGenres];
    const [moved] = updated.splice(index, 1);
    updated.splice(destination, 0, moved);
    setSelectedGenres(updated);
  };

  const handleSave = () => {
    onSave(
      selectedGenres.map((genre, index) => ({
        genreId: genre.id,
        rank: index + 1,
      }))
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="text-xs text-muted mt-1">
            Tap genres to add them in order, then use arrows to fine-tune ranking.
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="bg-accent hover:bg-accent-hover text-white text-sm font-medium px-4 py-2 rounded-xl transition-all disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save Rankings"}
        </button>
      </div>

      <div className="bg-card border border-border rounded-2xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold">Selected Genres</h4>
          <span className="text-[11px] text-muted">{selectedGenres.length} selected</span>
        </div>
        {selectedGenres.length === 0 ? (
          <p className="text-xs text-muted">
            No genres selected yet. Pick from the list below.
          </p>
        ) : (
          <div className="space-y-2">
            {selectedGenres.map((genre, index) => (
              <div
                key={genre.id}
                className="bg-accent/10 border border-accent/30 rounded-xl px-3 py-2 flex items-center gap-2"
              >
                <span className="w-6 h-6 rounded-md bg-accent text-white text-xs font-bold flex items-center justify-center">
                  {index + 1}
                </span>
                <span className="text-sm font-medium flex-1">{genre.name}</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => moveGenre(index, -1)}
                    disabled={index === 0}
                    className="p-1 rounded-md text-muted hover:text-foreground disabled:opacity-40"
                    aria-label={`Move ${genre.name} up`}
                  >
                    Up
                  </button>
                  <button
                    onClick={() => moveGenre(index, 1)}
                    disabled={index === selectedGenres.length - 1}
                    className="p-1 rounded-md text-muted hover:text-foreground disabled:opacity-40"
                    aria-label={`Move ${genre.name} down`}
                  >
                    Down
                  </button>
                  <button
                    onClick={() => unselectGenre(genre)}
                    className="text-[10px] px-2 py-1 rounded-md border border-border bg-card-hover text-muted hover:text-foreground"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-card border border-border rounded-2xl p-4 space-y-3">
        <h4 className="text-sm font-semibold">Available Genres</h4>
        <div className="flex flex-wrap gap-2">
          {availableGenres.map((genre) => (
            <button
              key={genre.id}
              onClick={() => selectGenre(genre)}
              className="text-xs px-3 py-1.5 rounded-full border border-border bg-card-hover text-muted hover:text-foreground hover:border-accent/30 transition-all"
            >
              {genre.name}
            </button>
          ))}
          {availableGenres.length === 0 && (
            <p className="text-xs text-muted">All genres are selected.</p>
          )}
        </div>
      </div>
    </div>
  );
}
