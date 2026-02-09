"use client";

import { useState, memo } from "react";
import Image from "next/image";
import StarRating from "./StarRating";

interface TinderMovieCardProps {
  movie: {
    id: string;
    title: string;
    year?: number | null;
    posterUrl?: string | null;
    overview?: string | null;
    era?: string | null;
    imdbId?: string | null;
    imdbRating?: number | null;
    rottenTomatoesAudience?: number | null;
    tmdbRating?: number | null;
    genres?: string[];
    anticipatedListCount?: number | null;
    directors?: string[];
    actors?: string[];
    studios?: string[];
  };
  rating?: number | null;
  hasSeen?: boolean;
  onRate?: (rating: number) => void;
  onSeenToggle?: (seen: boolean) => void;
  onNotHeardOf?: () => void;
}

function TinderMovieCardInner({
  movie,
  rating,
  hasSeen,
  onRate,
  onSeenToggle,
  onNotHeardOf,
}: TinderMovieCardProps) {
  const [showDetails, setShowDetails] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  return (
    <div className="relative w-full h-[calc(100vh-180px)] min-h-[500px] max-h-[900px] sm:max-h-[800px] rounded-3xl overflow-hidden shadow-2xl">
      {/* Full-size poster background */}
      {movie.posterUrl ? (
        <>
          {/* Placeholder while loading */}
          {!imageLoaded && (
            <div className="absolute inset-0 bg-card-hover flex items-center justify-center">
              <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          <Image
            src={movie.posterUrl}
            alt={movie.title}
            fill
            className={`object-cover transition-opacity duration-200 ${imageLoaded ? "opacity-100" : "opacity-0"}`}
            sizes="(max-width: 768px) 100vw, 600px"
            priority
            onLoad={() => setImageLoaded(true)}
          />
        </>
      ) : (
        <div className="absolute inset-0 bg-card-hover flex items-center justify-center">
          <div className="text-center p-8">
            <svg
              className="w-20 h-20 mx-auto text-muted mb-4"
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
            <p className="text-muted text-sm">No poster available</p>
          </div>
        </div>
      )}

      {/* Gradient overlay for text readability */}
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent" />

      {/* Top left - Year/Era/Genre badges */}
      <div className="absolute top-4 left-4 flex flex-wrap gap-1.5 max-w-[60%]">
        {movie.year && (
          <span className="bg-black/60 backdrop-blur-sm text-white text-sm font-semibold px-3 py-1 rounded-full">
            {movie.year}
          </span>
        )}
        {movie.anticipatedListCount !== null && movie.anticipatedListCount !== undefined ? (
          <span className="bg-accent/70 backdrop-blur-sm text-white text-xs font-semibold px-2.5 py-1 rounded-full">
            {movie.anticipatedListCount} lists
          </span>
        ) : null}
        {movie.genres && movie.genres.length > 0 && movie.genres.slice(0, 2).map((genre) => (
          <span
            key={genre}
            className="bg-white/20 backdrop-blur-sm text-white text-xs font-medium px-2.5 py-1 rounded-full"
          >
            {genre}
          </span>
        ))}
      </div>

      {/* Top right - Action buttons */}
      <div className="absolute top-4 right-4 flex gap-2">
        {/* IMDB Link */}
        {movie.imdbId && (
          <a
            href={`https://www.imdb.com/title/${movie.imdbId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-[#f5c518] text-black p-2 rounded-full hover:bg-[#e0b015] transition-all font-bold text-xs flex items-center justify-center w-9 h-9"
            onClick={(e) => e.stopPropagation()}
          >
            IMDb
          </a>
        )}
        {/* Toggle details button */}
        <button
          onClick={() => setShowDetails(!showDetails)}
          className="bg-black/60 backdrop-blur-sm text-white p-2 rounded-full hover:bg-black/80 transition-all"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            {showDetails ? (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            )}
          </svg>
        </button>
      </div>

      {/* Ratings badges - below top buttons */}
      {(movie.imdbRating !== null && movie.imdbRating !== undefined) ||
      (movie.rottenTomatoesAudience !== null &&
        movie.rottenTomatoesAudience !== undefined) ||
      (movie.tmdbRating !== null && movie.tmdbRating !== undefined) ? (
        <div className="absolute top-16 right-4 flex flex-col gap-1.5">
          {movie.imdbRating !== null && movie.imdbRating !== undefined ? (
            <div className="bg-[#f5c518]/90 backdrop-blur-sm text-black text-xs font-bold px-2 py-1 rounded-lg flex items-center gap-1">
              <span>⭐</span>
              <span>{movie.imdbRating.toFixed(1)}</span>
            </div>
          ) : null}
          {movie.rottenTomatoesAudience !== null &&
          movie.rottenTomatoesAudience !== undefined ? (
            <div className={`backdrop-blur-sm text-white text-xs font-bold px-2 py-1 rounded-lg flex items-center gap-1 ${
              movie.rottenTomatoesAudience >= 60 ? "bg-red-500/90" : "bg-green-600/90"
            }`}>
              <span>{movie.rottenTomatoesAudience >= 60 ? "🍅" : "🥬"}</span>
              <span>{movie.rottenTomatoesAudience}%</span>
            </div>
          ) : null}
          {movie.tmdbRating !== null && movie.tmdbRating !== undefined ? (
            <div className="bg-sky-500/90 backdrop-blur-sm text-white text-xs font-bold px-2 py-1 rounded-lg flex items-center gap-1">
              <span>TMDB</span>
              <span>{movie.tmdbRating.toFixed(1)}</span>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Main content at bottom */}
      <div className="absolute bottom-0 left-0 right-0 p-5 space-y-4">
        {/* Title */}
        <div>
          <h2 className="text-2xl sm:text-3xl font-bold text-white leading-tight">
            {movie.title}
          </h2>

          {/* Directors & Actors - always visible line */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-sm text-white/80">
            {movie.directors && movie.directors.length > 0 && (
              <span>Dir: {movie.directors.join(", ")}</span>
            )}
            {movie.actors && movie.actors.length > 0 && (
              <span>Starring: {movie.actors.slice(0, 2).join(", ")}</span>
            )}
          </div>

          {/* Description - always visible, expands on toggle */}
          {movie.overview && (
            <p className={`text-sm text-white/90 mt-2 ${showDetails ? "" : "line-clamp-2"}`}>
              {movie.overview}
            </p>
          )}
        </div>

        {/* Expanded details - studios */}
        {showDetails && movie.studios && movie.studios.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs text-white/70">
              Studio: {movie.studios.join(", ")}
            </p>
          </div>
        )}

        {/* Watch status toggle */}
        {onSeenToggle && (
          <div className="flex gap-2">
            <button
              onClick={() => onSeenToggle(false)}
              className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all ${
                !hasSeen
                  ? "bg-warning text-white"
                  : "bg-white/20 text-white hover:bg-white/30"
              }`}
            >
              Unseen
            </button>
            <button
              onClick={() => onSeenToggle(true)}
              className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all ${
                hasSeen
                  ? "bg-success text-white"
                  : "bg-white/20 text-white hover:bg-white/30"
              }`}
            >
              Seen
            </button>
          </div>
        )}

        {/* Star rating */}
        {onRate && (
          <div className="bg-black/40 backdrop-blur-sm rounded-2xl p-4">
            <p className="text-xs text-white/70 mb-2 text-center">
              {hasSeen
                ? "How much did you like it?"
                : "How much do you want to watch it?"}
            </p>
            <div className="flex justify-center">
              <StarRating
                rating={rating ?? null}
                onChange={onRate}
                size="xl"
              />
            </div>
          </div>
        )}

        {/* Not heard of button */}
        {onNotHeardOf && (
          <button
            onClick={onNotHeardOf}
            className="w-full py-2 rounded-xl bg-white/10 text-white/70 text-sm hover:bg-white/20 transition-all"
          >
            I haven&apos;t heard of this movie
          </button>
        )}

        {/* Rating context hint */}
        {rating !== null && rating !== undefined && (
          <p className="text-[10px] text-white/60 text-center">
            {hasSeen
              ? "You marked this as seen. Stars = how much you liked it."
              : "You marked this as unseen. Stars = willingness to watch."}
          </p>
        )}
      </div>
    </div>
  );
}

// Memoize to prevent re-renders when parent state changes
const TinderMovieCard = memo(TinderMovieCardInner, (prevProps, nextProps) => {
  // Only re-render if these specific props change
  return (
    prevProps.movie.id === nextProps.movie.id &&
    prevProps.rating === nextProps.rating &&
    prevProps.hasSeen === nextProps.hasSeen
  );
});

export default TinderMovieCard;

