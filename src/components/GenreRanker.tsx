"use client";

import { useState, useCallback } from "react";

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
  // Sort genres by initial ranking, unranked at the end
  const [ranked, setRanked] = useState<Genre[]>(() => {
    const sorted = [...genres].sort((a, b) => {
      const aRank = initialRankings[a.id] ?? 999;
      const bRank = initialRankings[b.id] ?? 999;
      return aRank - bRank;
    });
    return sorted;
  });

  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const moveGenre = useCallback(
    (from: number, to: number) => {
      const updated = [...ranked];
      const [moved] = updated.splice(from, 1);
      updated.splice(to, 0, moved);
      setRanked(updated);
    },
    [ranked]
  );

  const handleSave = () => {
    const rankings = ranked.map((g, i) => ({
      genreId: g.id,
      rank: i + 1,
    }));
    onSave(rankings);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">{title}</h3>
        <button
          onClick={handleSave}
          disabled={saving}
          className="bg-accent hover:bg-accent-hover text-white text-sm font-medium px-4 py-2 rounded-xl transition-all disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save Rankings"}
        </button>
      </div>

      <p className="text-sm text-muted">
        Drag to reorder. Top = most favorite.
      </p>

      <div className="space-y-1.5">
        {ranked.map((genre, idx) => (
          <div
            key={genre.id}
            draggable
            onDragStart={() => setDragIdx(idx)}
            onDragOver={(e) => {
              e.preventDefault();
              if (dragIdx !== null && dragIdx !== idx) {
                moveGenre(dragIdx, idx);
                setDragIdx(idx);
              }
            }}
            onDragEnd={() => setDragIdx(null)}
            className={`flex items-center gap-3 bg-card border border-border rounded-xl px-4 py-3 transition-all cursor-grab active:cursor-grabbing ${
              dragIdx === idx
                ? "opacity-50 scale-95 border-accent"
                : "hover:border-accent/30"
            }`}
          >
            <span className="w-7 h-7 flex items-center justify-center bg-accent-soft text-accent text-sm font-bold rounded-lg flex-shrink-0">
              {idx + 1}
            </span>
            <svg
              className="w-4 h-4 text-muted flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 8h16M4 16h16"
              />
            </svg>
            <span className="text-sm font-medium">{genre.name}</span>
          </div>
        ))}
      </div>

      {/* Mobile touch: use up/down buttons */}
      <div className="sm:hidden space-y-1">
        {ranked.map((genre, idx) => (
          <div
            key={`mobile-${genre.id}`}
            className="flex items-center gap-2 bg-card border border-border rounded-xl px-3 py-2"
          >
            <span className="w-6 h-6 flex items-center justify-center bg-accent-soft text-accent text-xs font-bold rounded-md flex-shrink-0">
              {idx + 1}
            </span>
            <span className="text-sm font-medium flex-1">{genre.name}</span>
            <div className="flex flex-col gap-0.5">
              <button
                onClick={() => idx > 0 && moveGenre(idx, idx - 1)}
                disabled={idx === 0}
                className="text-muted hover:text-foreground disabled:opacity-30 p-0.5"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                </svg>
              </button>
              <button
                onClick={() =>
                  idx < ranked.length - 1 && moveGenre(idx, idx + 1)
                }
                disabled={idx === ranked.length - 1}
                className="text-muted hover:text-foreground disabled:opacity-30 p-0.5"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
