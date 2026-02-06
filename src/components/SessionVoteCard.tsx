"use client";

import Image from "next/image";
import StarRating from "./StarRating";

interface SessionVoteCardProps {
  movie: {
    id: string;
    title: string;
    year?: number | null;
    posterUrl?: string | null;
    overview?: string | null;
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
  return (
    <div className="bg-card rounded-2xl border border-border overflow-hidden animate-slide-up">
      <div className="flex">
        {/* Poster */}
        <div className="relative w-24 h-36 flex-shrink-0 bg-card-hover">
          {movie.posterUrl ? (
            <Image
              src={movie.posterUrl}
              alt={movie.title}
              fill
              className="object-cover"
              sizes="96px"
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
        <div className="flex-1 p-3 space-y-2">
          <div>
            <h3 className="font-semibold text-sm leading-tight">{movie.title}</h3>
            {movie.year && <span className="text-xs text-muted">{movie.year}</span>}
          </div>

          {movie.overview && (
            <p className="text-[11px] text-muted line-clamp-2">{movie.overview}</p>
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
              {willingToRewatch ? "Willing to rewatch" : "Seen it - tap if willing to rewatch"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
