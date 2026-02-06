"use client";

import { useState } from "react";

interface StarRatingProps {
  rating: number | null;
  onChange?: (rating: number) => void;
  size?: "sm" | "md" | "lg";
  readonly?: boolean;
}

export default function StarRating({
  rating,
  onChange,
  size = "md",
  readonly = false,
}: StarRatingProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [animating, setAnimating] = useState<number | null>(null);

  const sizes = { sm: "w-5 h-5", md: "w-7 h-7", lg: "w-9 h-9" };
  const gaps = { sm: "gap-0.5", md: "gap-1", lg: "gap-1.5" };

  const displayRating = hovered ?? rating ?? 0;

  const handleClick = (star: number) => {
    if (readonly || !onChange) return;
    setAnimating(star);
    onChange(star);
    setTimeout(() => setAnimating(null), 200);
  };

  return (
    <div className={`flex items-center ${gaps[size]}`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          disabled={readonly}
          className={`${sizes[size]} transition-transform ${
            !readonly ? "hover:scale-110 cursor-pointer" : "cursor-default"
          } ${animating === star ? "star-animate" : ""}`}
          onMouseEnter={() => !readonly && setHovered(star)}
          onMouseLeave={() => setHovered(null)}
          onClick={() => handleClick(star)}
        >
          <svg viewBox="0 0 24 24" className="w-full h-full">
            <path
              d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
              fill={star <= displayRating ? "var(--star)" : "transparent"}
              stroke={star <= displayRating ? "var(--star)" : "var(--muted)"}
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      ))}
      {rating !== null && (
        <span className="text-xs text-muted ml-1">{rating}/5</span>
      )}
    </div>
  );
}
