"use client";

import { useState } from "react";
import Image from "next/image";
import StarRating from "./StarRating";

interface MovieCardProps {
  movie: {
    id: string;
    title: string;
    year?: number | null;
    posterUrl?: string | null;
    overview?: string | null;
    era?: string | null;
    directors?: string[];
    actors?: string[];
    studios?: string[];
  };
  rating?: number | null;
  hasSeen?: boolean;
  available?: boolean;
  onRate?: (rating: number) => void;
  onSeenToggle?: (seen: boolean) => void;
  onNotHeardOf?: () => void;
  compact?: boolean;
}

export default function MovieCard({
  movie,
  rating,
  hasSeen,
  available,
  onRate,
  onSeenToggle,
  onNotHeardOf,
  compact = false,
}: MovieCardProps) {
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const eraLabels: Record<string, string> = {
    new_release: "New Release",
    modern_classic: "Modern Classic",
    classic: "Classic",
  };

  return (
    <div className="bg-card rounded-2xl border border-border overflow-hidden hover:border-accent/30 transition-all animate-slide-up">
      <div className={`flex ${compact ? "flex-row" : "flex-col sm:flex-row"}`}>
        {/* Poster */}
        <div
          className={`relative flex-shrink-0 bg-card-hover ${
            compact ? "w-16 h-24" : "w-full sm:w-36 h-48 sm:h-auto"
          }`}
        >
          {movie.posterUrl ? (
            <Image
              src={movie.posterUrl}
              alt={movie.title}
              fill
              className="object-cover"
              sizes={compact ? "64px" : "112px"}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-muted">
              <svg
                className="w-8 h-8"
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
          {available && (
            <div className="absolute top-1 right-1 bg-success/90 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
              Available
            </div>
          )}
        </div>

        {/* Info */}
        <div className={`flex-1 ${compact ? "p-3" : "p-4"}`}>
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3
                className={`font-semibold text-foreground leading-tight ${
                  compact ? "text-sm" : "text-base"
                }`}
              >
                {movie.title}
              </h3>
              <div className="flex items-center gap-2 mt-0.5">
                {movie.year && (
                  <span className="text-xs text-muted">{movie.year}</span>
                )}
                {movie.era && (
                  <span className="text-[10px] bg-accent-soft text-accent px-2 py-0.5 rounded-full font-medium">
                    {eraLabels[movie.era] || movie.era}
                  </span>
                )}
              </div>
            </div>
          </div>

          {!compact && movie.overview && (
            <div className="mt-2">
              <p
                className={`text-xs text-muted ${
                  descriptionExpanded ? "" : "line-clamp-2"
                }`}
              >
                {movie.overview}
              </p>
              {movie.overview.length > 140 && (
                <button
                  onClick={() => setDescriptionExpanded((prev) => !prev)}
                  className="text-[11px] text-accent hover:underline mt-1"
                >
                  {descriptionExpanded ? "Show less" : "Show more"}
                </button>
              )}
            </div>
          )}

          {!compact && (
            <div className="mt-2 space-y-1 text-[11px] text-muted">
              {movie.directors && movie.directors.length > 0 && (
                <p>
                  Director:{" "}
                  <span className="text-foreground">{movie.directors.join(", ")}</span>
                </p>
              )}
              {movie.actors && movie.actors.length > 0 && (
                <p>
                  Lead actors:{" "}
                  <span className="text-foreground">{movie.actors.join(", ")}</span>
                </p>
              )}
              {movie.studios && movie.studios.length > 0 && (
                <p>
                  Studio:{" "}
                  <span className="text-foreground">{movie.studios.join(", ")}</span>
                </p>
              )}
            </div>
          )}

          {/* Rating & Actions */}
          {onRate && (
            <div className="mt-3 space-y-2">
              {onSeenToggle && (
                <div className="space-y-1">
                  <p className="text-[11px] text-muted">
                    Watch status for this title
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => onSeenToggle(false)}
                      className={`text-xs px-2.5 py-1.5 rounded-lg border transition-all font-medium ${
                        !hasSeen
                          ? "bg-warning/15 text-warning border-warning/30"
                          : "bg-card-hover text-muted border-border hover:text-foreground"
                      }`}
                    >
                      Unseen
                    </button>
                    <button
                      onClick={() => onSeenToggle(true)}
                      className={`text-xs px-2.5 py-1.5 rounded-lg border transition-all font-medium ${
                        hasSeen
                          ? "bg-success/15 text-success border-success/30"
                          : "bg-card-hover text-muted border-border hover:text-foreground"
                      }`}
                    >
                      Seen
                    </button>
                  </div>
                  <p className="text-[10px] text-muted">
                    Default is <span className="text-foreground">Unseen</span>.
                  </p>
                </div>
              )}

              <StarRating
                rating={rating ?? null}
                onChange={onRate}
                size={compact ? "sm" : "md"}
              />

              {onNotHeardOf && (
                <button
                  onClick={onNotHeardOf}
                  className="text-xs px-2.5 py-1 rounded-lg bg-card-hover text-muted border border-border hover:text-foreground transition-all"
                >
                  I haven&apos;t heard of this movie
                </button>
              )}

              {hasSeen && rating !== null && rating !== undefined && (
                <p className="text-[10px] text-muted font-medium">
                  You marked this as seen. Stars mean how much you liked it.
                </p>
              )}
              {!hasSeen && rating !== null && rating !== undefined && (
                <p className="text-[10px] text-muted font-medium">
                  You marked this as unseen. Stars mean willingness to watch.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
