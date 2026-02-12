"use client";

import { useState } from "react";
import Image from "next/image";
import StarRating from "./StarRating";

interface SessionVoteCardProps {
  movie: {
    id: string;
    title: string;
    year?: number | null;
    posterUrl?: string | null;
    overview?: string | null;
    directors?: string[];
    actors?: string[];
    studios?: string[];
  };
  sessionMovieId: string;
  userHasSeen?: boolean;
  rating: number | null;
  willingToRewatch: boolean;
  onRate: (rating: number) => void;
  onRewatchToggle: (willing: boolean) => void;
  available?: boolean;
}

export default function SessionVoteCard({
  movie,
  userHasSeen,
  rating,
  willingToRewatch,
  onRate,
  onRewatchToggle,
  available,
}: SessionVoteCardProps) {
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);

  return (
    <div className="bg-card rounded-2xl border border-border overflow-hidden animate-slide-up">
      <div className="flex flex-col sm:flex-row">
        {/* Poster */}
        <div className="relative w-full h-52 sm:w-32 sm:h-auto flex-shrink-0 bg-card-hover">
          {movie.posterUrl ? (
            <Image
              src={movie.posterUrl}
              alt={movie.title}
              fill
              className="object-cover"
              sizes="(max-width: 640px) 100vw, 128px"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-muted">
              <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" />
              </svg>
            </div>
          )}
          {available && (
            <div className="absolute top-1 right-1 bg-success/90 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
              On Server
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 p-4 space-y-2">
          <div>
            <h3 className="font-semibold text-sm leading-tight">{movie.title}</h3>
            {movie.year && <span className="text-xs text-muted">{movie.year}</span>}
          </div>

          {movie.overview && (
            <div>
              <p
                className={`text-[11px] text-muted ${
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

          <div className="space-y-1 text-[11px] text-muted">
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
                Studio: <span className="text-foreground">{movie.studios.join(", ")}</span>
              </p>
            )}
          </div>

          {userHasSeen ? (
            <p className="text-[11px] text-success font-medium">
              You have seen this before.
            </p>
          ) : (
            <p className="text-[11px] text-warning font-medium">
              You have not seen this yet.
            </p>
          )}

          <div>
            <p className="text-[10px] text-muted mb-1">
              How willing are you to watch this tonight?
            </p>
            <StarRating rating={rating} onChange={onRate} size="sm" />
          </div>

          {userHasSeen && (
            <button
              onClick={() => onRewatchToggle(!willingToRewatch)}
              className={`text-[11px] px-2 py-1 rounded-lg transition-all ${
                willingToRewatch
                  ? "bg-accent-soft text-accent border border-accent/30"
                  : "bg-card-hover text-muted border border-border"
              }`}
            >
              {willingToRewatch
                ? "Willing to rewatch"
                : "Seen it. Tap if willing to rewatch"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
