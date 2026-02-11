"use client";

import { Suspense, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

interface AffinityItem {
  id: string;
  name: string;
  affinity: number;
  ratingCount: number;
}

interface ArchetypeMovieExample {
  id: string;
  title: string;
  year: number | null;
  posterUrl: string | null;
  uniqueness: number;
  similarity: number;
}

interface ArchetypeSignature {
  yearRange?: { min: number | null; max: number | null; median: number | null };
  decades?: string[];
  eras?: string[];
  tags?: string[];
  directors?: string[];
  actors?: string[];
  studios?: string[];
}

interface MovieQuickRating {
  rating: number | null;
  hasSeen: boolean;
  notHeardOf: boolean;
}

interface RateableMovie {
  id: string;
  title: string;
  year: number | null;
  posterUrl: string | null;
}

interface ProfileStats {
  user: {
    id: string;
    name: string;
    explorationFactor: number;
    discoverySourcePref: string;
  };
  counts: {
    moviesRated: number;
    moviesSeen: number;
    actorsRated: number;
    directorsRated: number;
    studiosRated: number;
    genresRanked: number;
  };
  topGenres: AffinityItem[];
  bottomGenres: AffinityItem[];
  topActors: AffinityItem[];
  bottomActors: AffinityItem[];
  topDirectors: AffinityItem[];
  bottomDirectors: AffinityItem[];
  topStudios: AffinityItem[];
  bottomStudios: AffinityItem[];
  recentHighRatedMovies: {
    id: string;
    title: string;
    year: number | null;
    posterUrl: string | null;
    rating: number;
  }[];
  ratingDistribution: {
    rating: number;
    count: number;
  }[];
  mlModel: {
    confidence: number;
    trainedEpochs: number;
    totalRatings: number;
    rmse: number | null;
    validationRmse: number | null;
    featuresLearned: number;
    lastTrainedAt: string | null;
    isTraining: boolean;
  } | null;
  moviePersonality: {
    archetypeName: string;
    description: string;
    traits: string[];
    disposition: string;
    dispositionLabel: string;
    dispositionExplanation: string;
    topGenres: { name: string; score: number }[];
    archetypeSimilarities?: { name: string; score: number }[];
    archetypeMostLovedMovies?: ArchetypeMovieExample[];
    archetypeLovedMovies?: ArchetypeMovieExample[];
    archetypeHatedMovies?: ArchetypeMovieExample[];
    archetypeSignature?: ArchetypeSignature;
    ratingMean: number | null;
    ratingStdDev: number | null;
  } | null;
}

interface ProfileLoadError {
  userId: string;
  message: string;
}

interface HouseholdMemberOption {
  id: string;
  name: string;
  ratingCount: number;
}

function formatAffinityPercent(affinity: number): string {
  const clamped = Math.max(-1, Math.min(1, affinity)) * 100;
  // Truncate instead of round so near-max values don't present as 100%.
  const truncated = clamped >= 0
    ? Math.floor(clamped * 10) / 10
    : Math.ceil(clamped * 10) / 10;
  const sign = truncated > 0 ? "+" : "";
  return `${sign}${truncated.toFixed(1)}%`;
}

function AffinityBar({ affinity }: { affinity: number }) {
  // affinity is -1 to 1, we need to map it to 0-100%
  const percentage = ((affinity + 1) / 2) * 100;
  const isPositive = affinity >= 0;

  return (
    <div className="w-20 h-2 bg-border rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-all ${
          isPositive ? "bg-success" : "bg-error"
        }`}
        style={{ width: `${percentage}%` }}
      />
    </div>
  );
}

function AffinitySection({
  title,
  topItems,
  bottomItems,
  icon,
}: {
  title: string;
  topItems: AffinityItem[];
  bottomItems: AffinityItem[];
  icon: React.ReactNode;
}) {
  if (topItems.length === 0 && bottomItems.length === 0) {
    return null;
  }

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-8 h-8 bg-accent-soft rounded-lg flex items-center justify-center">
          {icon}
        </div>
        <h3 className="font-semibold">{title}</h3>
      </div>

      {topItems.length > 0 && (
        <div className="mb-4">
          <div className="text-xs text-muted mb-2 uppercase tracking-wide">
            Favorites
          </div>
          <div className="space-y-2">
            {topItems.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-2"
              >
                <span className="text-sm truncate flex-1">{item.name}</span>
                <div className="flex items-center gap-2">
                  <AffinityBar affinity={item.affinity} />
                  <span className="text-xs text-muted w-14 text-right tabular-nums">
                    {formatAffinityPercent(item.affinity)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {bottomItems.length > 0 && (
        <div>
          <div className="text-xs text-muted mb-2 uppercase tracking-wide">
            Least Preferred
          </div>
          <div className="space-y-2">
            {bottomItems.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-2"
              >
                <span className="text-sm truncate flex-1">{item.name}</span>
                <div className="flex items-center gap-2">
                  <AffinityBar affinity={item.affinity} />
                  <span className="text-xs text-muted w-14 text-right tabular-nums">
                    {formatAffinityPercent(item.affinity)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RatingDistribution({
  distribution,
}: {
  distribution: { rating: number; count: number }[];
}) {
  const maxCount = Math.max(...distribution.map((d) => d.count), 1);

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <h3 className="font-semibold mb-4">Rating Distribution</h3>
      <div className="flex items-end justify-between gap-2 h-24">
        {distribution.map((d) => (
          <div key={d.rating} className="flex-1 flex flex-col items-center">
            <div
              className="w-full bg-accent rounded-t transition-all"
              style={{
                height: `${(d.count / maxCount) * 100}%`,
                minHeight: d.count > 0 ? "4px" : "0",
              }}
            />
            <div className="text-xs text-muted mt-1">{d.rating}</div>
            <div className="text-xs font-medium">{d.count}</div>
          </div>
        ))}
      </div>
      <div className="text-center text-xs text-muted mt-2">Star Rating</div>
    </div>
  );
}

function ProfileMovieCard({
  movie,
  canRate,
  ratingState,
  isSaving,
  onRate,
  onToggleSeen,
}: {
  movie: RateableMovie;
  canRate: boolean;
  ratingState: MovieQuickRating;
  isSaving: boolean;
  onRate: (movieId: string, rating: number) => void;
  onToggleSeen: (movieId: string) => void;
}) {
  return (
    <div className="group shrink-0 w-24">
      <div className="relative rounded-lg overflow-hidden border border-border">
        {movie.posterUrl ? (
          <img
            src={movie.posterUrl}
            alt={movie.title}
            className="w-full aspect-[2/3] object-cover"
          />
        ) : (
          <div className="w-full aspect-[2/3] bg-border flex items-center justify-center">
            <span className="text-xs text-muted">No poster</span>
          </div>
        )}

        <div className="absolute inset-0 bg-black/70 p-1.5 flex flex-col justify-end transition-opacity opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
          <div className="text-[10px] text-white/90 mb-1 truncate">
            {ratingState.rating ? `Your rating: ${ratingState.rating}/5` : "Not rated yet"}
          </div>

          <button
            type="button"
            className={`text-[10px] px-1.5 py-0.5 rounded border mb-1 text-left ${
              ratingState.hasSeen
                ? "bg-emerald-500/30 border-emerald-300/50 text-emerald-100"
                : "bg-white/10 border-white/30 text-white"
            } ${canRate ? "hover:bg-white/20" : "opacity-60 cursor-not-allowed"}`}
            disabled={!canRate || isSaving}
            onClick={() => onToggleSeen(movie.id)}
          >
            {ratingState.hasSeen ? "Seen" : "Unseen"}
          </button>

          <div className="flex items-center gap-0.5">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                className={`w-3.5 h-3.5 ${canRate ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}
                disabled={!canRate || isSaving}
                onClick={() => onRate(movie.id, star)}
                title={`Rate ${star} stars`}
              >
                <svg
                  viewBox="0 0 20 20"
                  className={`w-full h-full ${
                    (ratingState.rating ?? 0) >= star
                      ? "text-yellow-400"
                      : "text-white/45"
                  }`}
                  fill="currentColor"
                >
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
              </button>
            ))}
          </div>
          {isSaving && <div className="text-[10px] text-white/80 mt-1">Saving...</div>}
        </div>
      </div>

      <div className="text-[11px] font-medium truncate mt-1">
        {movie.title}
      </div>
      {movie.year ? (
        <div className="text-[10px] text-muted">{movie.year}</div>
      ) : null}
    </div>
  );
}

function MoviePersonalityCard({
  personality,
  canRate,
  movieRatings,
  savingMovieIds,
  onRate,
  onToggleSeen,
}: {
  personality: NonNullable<ProfileStats["moviePersonality"]>;
  canRate: boolean;
  movieRatings: Record<string, MovieQuickRating>;
  savingMovieIds: Record<string, boolean>;
  onRate: (movieId: string, rating: number) => void;
  onToggleSeen: (movieId: string) => void;
}) {
  const renderPosterRow = (
    title: string,
    movies: ArchetypeMovieExample[] | undefined
  ) => {
    if (!movies || movies.length === 0) return null;
    return (
      <div className="mb-4">
        <div className="text-sm font-medium mb-2">{title}</div>
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
          {movies.slice(0, 10).map((m) => (
            <ProfileMovieCard
              key={m.id}
              movie={{ id: m.id, title: m.title, year: m.year, posterUrl: m.posterUrl }}
              canRate={canRate}
              ratingState={movieRatings[m.id] ?? { rating: null, hasSeen: false, notHeardOf: false }}
              isSaving={Boolean(savingMovieIds[m.id])}
              onRate={onRate}
              onToggleSeen={onToggleSeen}
            />
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-8 h-8 bg-accent-soft rounded-lg flex items-center justify-center">
          <svg
            className="w-4 h-4 text-accent"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"
            />
          </svg>
        </div>
        <h3 className="font-semibold">Your Movie Personality</h3>
      </div>

      <div className="space-y-4">
        {/* Archetype Name */}
        <div>
          <div className="text-lg font-bold text-accent">
            {personality.archetypeName}
          </div>
          <div className="text-sm text-muted mt-0.5">
            {personality.description}
          </div>
        </div>

        {/* Distinctive Genres */}
        {personality.topGenres.length > 0 && (
          <div>
            <div className="text-xs text-muted uppercase tracking-wide mb-2">
              Distinctive Genres
            </div>
            <div className="flex flex-wrap gap-2">
              {personality.topGenres.map((genre, i) => (
                <span
                  key={i}
                  className="px-2.5 py-1 bg-accent/10 border border-accent/20 rounded-lg text-sm"
                >
                  {genre.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Distinctive tags/directors/actors/years */}
        {personality.archetypeSignature && (
          <div className="space-y-3">
            {personality.archetypeSignature.yearRange &&
              (personality.archetypeSignature.yearRange.min != null ||
                personality.archetypeSignature.yearRange.max != null) && (
                <div>
                  <div className="text-xs text-muted uppercase tracking-wide mb-2">
                    Typical Years
                  </div>
                  <div className="text-sm">
                    {personality.archetypeSignature.yearRange.min ?? "?"}..{personality.archetypeSignature.yearRange.max ?? "?"}
                    {personality.archetypeSignature.yearRange.median != null
                      ? ` (median ${personality.archetypeSignature.yearRange.median})`
                      : ""}
                  </div>
                  {personality.archetypeSignature.decades &&
                    personality.archetypeSignature.decades.length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-2">
                        {personality.archetypeSignature.decades.slice(0, 6).map((d) => (
                          <span
                            key={d}
                            className="px-2 py-1 bg-border/40 border border-border rounded-lg text-xs"
                          >
                            {d}
                          </span>
                        ))}
                      </div>
                    )}
                </div>
              )}

            {personality.archetypeSignature.tags &&
              personality.archetypeSignature.tags.length > 0 && (
                <div>
                  <div className="text-xs text-muted uppercase tracking-wide mb-2">
                    Distinctive Tags
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {personality.archetypeSignature.tags.slice(0, 10).map((t) => (
                      <span
                        key={t}
                        className="px-2 py-1 bg-border/40 border border-border rounded-lg text-xs"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              )}

            {personality.archetypeSignature.directors &&
              personality.archetypeSignature.directors.length > 0 && (
                <div>
                  <div className="text-xs text-muted uppercase tracking-wide mb-2">
                    Recurring Directors
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {personality.archetypeSignature.directors.slice(0, 6).map((d) => (
                      <span
                        key={d}
                        className="px-2 py-1 bg-border/40 border border-border rounded-lg text-xs"
                      >
                        {d}
                      </span>
                    ))}
                  </div>
                </div>
              )}

            {personality.archetypeSignature.actors &&
              personality.archetypeSignature.actors.length > 0 && (
                <div>
                  <div className="text-xs text-muted uppercase tracking-wide mb-2">
                    Recurring Actors
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {personality.archetypeSignature.actors.slice(0, 8).map((a) => (
                      <span
                        key={a}
                        className="px-2 py-1 bg-border/40 border border-border rounded-lg text-xs"
                      >
                        {a}
                      </span>
                    ))}
                  </div>
                </div>
              )}

            {personality.archetypeSignature.studios &&
              personality.archetypeSignature.studios.length > 0 && (
                <div>
                  <div className="text-xs text-muted uppercase tracking-wide mb-2">
                    Recurring Studios
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {personality.archetypeSignature.studios.slice(0, 6).map((s) => (
                      <span
                        key={s}
                        className="px-2 py-1 bg-border/40 border border-border rounded-lg text-xs"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              )}
          </div>
        )}

        {/* Similarity distribution */}
        {personality.archetypeSimilarities && personality.archetypeSimilarities.length > 0 && (
          <div>
            <div className="text-xs text-muted uppercase tracking-wide mb-2">
              Similar To
            </div>
            <div className="space-y-2">
              {personality.archetypeSimilarities.map((a, i) => (
                <div key={i} className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium">{a.name}</div>
                  <div className="flex items-center gap-2 min-w-[110px] justify-end">
                    <div className="h-2 w-20 bg-white/10 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-accent"
                        style={{ width: `${Math.round(Math.max(0, Math.min(1, a.score)) * 100)}%` }}
                      />
                    </div>
                    <div className="text-xs text-muted tabular-nums">
                      {Math.round(Math.max(0, Math.min(1, a.score)) * 100)}%
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Archetype example movies */}
        {(personality.archetypeMostLovedMovies?.length ||
          personality.archetypeLovedMovies?.length ||
          personality.archetypeHatedMovies?.length) ? (
          <div>
            <div className="text-xs text-muted uppercase tracking-wide mb-2">
              Archetype Examples
            </div>
            <div className="text-xs text-muted mb-3">
              A mix of generally loved titles for this archetype plus movies it is unusually likely to love or avoid (compared to other archetypes).
            </div>

            {renderPosterRow("Most Loved", personality.archetypeMostLovedMovies)}
            {renderPosterRow("Uniquely Loved", personality.archetypeLovedMovies)}
            {renderPosterRow("Uniquely Avoided", personality.archetypeHatedMovies)}
          </div>
        ) : null}

        {/* Viewing Traits */}
        {personality.traits.length > 0 && (
          <div>
            <div className="text-xs text-muted uppercase tracking-wide mb-2">
              Viewing Traits
            </div>
            <ul className="space-y-1">
              {personality.traits.map((trait, i) => (
                <li
                  key={i}
                  className="text-sm flex items-start gap-2"
                >
                  <span className="text-accent mt-0.5">&#8226;</span>
                  <span>{trait}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Rating Style */}
        <div>
          <div className="text-xs text-muted uppercase tracking-wide mb-1">
            Rating Style
          </div>
          <div className="text-sm font-medium">
            {personality.dispositionLabel}
          </div>
          <div className="text-sm text-muted italic mt-0.5">
            {personality.dispositionExplanation}
          </div>
        </div>

        {/* Rating Stats */}
        {personality.ratingMean != null && (
          <div className="flex items-center gap-4 pt-2 border-t border-border">
            <div>
              <div className="text-xs text-muted">Avg Rating</div>
              <div className="text-sm font-medium">
                {personality.ratingMean.toFixed(1)} / 5
              </div>
            </div>
            {personality.ratingStdDev != null && (
              <div>
                <div className="text-xs text-muted">Spread</div>
                <div className="text-sm font-medium">
                  &plusmn;{personality.ratingStdDev.toFixed(2)}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ProfilePageContent() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [stats, setStats] = useState<ProfileStats | null>(null);
  const [householdMembers, setHouseholdMembers] = useState<HouseholdMemberOption[]>([]);
  const [error, setError] = useState<ProfileLoadError | null>(null);
  const [movieRatings, setMovieRatings] = useState<Record<string, MovieQuickRating>>({});
  const [savingMovieIds, setSavingMovieIds] = useState<Record<string, boolean>>({});

  const selectedUserId =
    searchParams.get("userId")?.trim() ||
    session?.user?.id ||
    null;

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  useEffect(() => {
    if (status !== "authenticated" || !selectedUserId) return;

    let isCancelled = false;

    Promise.all([
      fetch(`/api/profile/stats?userId=${encodeURIComponent(selectedUserId)}`),
      fetch("/api/household").catch(() => null),
    ])
      .then(async ([statsResponse, householdResponse]) => {
        if (!statsResponse.ok) {
          throw new Error(
            statsResponse.status === 403
              ? "You can only view profiles for members of your household"
              : "Failed to load profile stats"
          );
        }

        const statsData = (await statsResponse.json()) as ProfileStats;
        if (isCancelled) return;
        setStats(statsData);
        setError(null);

        if (householdResponse && householdResponse.ok) {
          const households = await householdResponse.json();
          const memberMap = new Map<string, HouseholdMemberOption>();

          if (Array.isArray(households)) {
            for (const household of households) {
              if (!Array.isArray(household?.members)) continue;
              for (const member of household.members) {
                const user = member?.user;
                if (!user?.id || !user?.name) continue;
                if (!memberMap.has(user.id)) {
                  memberMap.set(user.id, {
                    id: user.id,
                    name: user.name,
                    ratingCount: user.ratingCount ?? 0,
                  });
                }
              }
            }
          }

          const members = Array.from(memberMap.values()).sort((a, b) =>
            a.name.localeCompare(b.name)
          );
          if (!isCancelled) {
            setHouseholdMembers(members);
          }
        }

      })
      .catch((err) => {
        if (!isCancelled) {
          setError({
            userId: selectedUserId,
            message: err instanceof Error ? err.message : "Failed to load profile stats",
          });
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [selectedUserId, status]);

  const activeError = error && error.userId === selectedUserId ? error.message : null;
  const isLoading =
    status === "loading" ||
    (status === "authenticated" &&
      !!selectedUserId &&
      !activeError &&
      (!stats || stats.user.id !== selectedUserId));

  const isOwnProfile = Boolean(stats && stats.user.id === (session?.user?.id ?? ""));
  const canQuickRate = status === "authenticated";

  useEffect(() => {
    if (status !== "authenticated") return;

    let cancelled = false;
    fetch("/api/ratings")
      .then((res) => (res.ok ? res.json() : []))
      .then((rows) => {
        if (cancelled || !Array.isArray(rows)) return;
        const next: Record<string, MovieQuickRating> = {};
        for (const row of rows) {
          if (!row?.movieId) continue;
          next[row.movieId] = {
            rating: typeof row.rating === "number" ? row.rating : null,
            hasSeen: Boolean(row.hasSeen),
            notHeardOf: Boolean(row.notHeardOf),
          };
        }
        setMovieRatings(next);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [status, session?.user?.id]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (activeError) {
    return (
      <div className="bg-error/10 border border-error/20 text-error text-sm px-4 py-2 rounded-xl">
        {activeError}
      </div>
    );
  }

  if (!stats) {
    return null;
  }

  const discoveryLabels: Record<string, string> = {
    popular: "Popular Movies",
    trending: "Trending Movies",
    top_rated: "Top Rated Movies",
    new_releases: "New Releases",
    indie_darlings: "Indie Darlings",
    balanced: "Balanced Mix",
    hidden_gems: "Hidden Gems",
  };

  const saveRating = async (movieId: string, next: MovieQuickRating) => {
    setSavingMovieIds((prev) => ({ ...prev, [movieId]: true }));
    try {
      const res = await fetch("/api/ratings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          movieId,
          rating: next.rating,
          hasSeen: next.hasSeen,
          notHeardOf: false,
        }),
      });
      if (!res.ok) {
        throw new Error("Failed to save rating");
      }
    } finally {
      setSavingMovieIds((prev) => ({ ...prev, [movieId]: false }));
    }
  };

  const handleRateMovie = (movieId: string, rating: number) => {
    if (!canQuickRate) return;
    const prev = movieRatings[movieId] ?? { rating: null, hasSeen: false, notHeardOf: false };
    const next: MovieQuickRating = { ...prev, rating, notHeardOf: false };
    setMovieRatings((curr) => ({ ...curr, [movieId]: next }));
    void saveRating(movieId, next);
  };

  const handleToggleSeen = (movieId: string) => {
    if (!canQuickRate) return;
    const prev = movieRatings[movieId] ?? { rating: null, hasSeen: false, notHeardOf: false };
    const next: MovieQuickRating = { ...prev, hasSeen: !prev.hasSeen };
    setMovieRatings((curr) => ({ ...curr, [movieId]: next }));

    // Persist immediately only when a rating exists; otherwise keep draft until stars are picked.
    if (next.rating !== null) {
      void saveRating(movieId, next);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">
            {isOwnProfile ? "Your Profile" : `${stats.user.name}'s Profile`}
          </h1>
          <p className="text-sm text-muted mt-1">
            What the algorithm has learned about {isOwnProfile ? "you" : stats.user.name}
          </p>
        </div>
        {isOwnProfile ? (
          <Link
            href="/preferences"
            className="text-sm text-accent hover:underline"
          >
            Edit Preferences
          </Link>
        ) : (
          <Link
            href="/profile"
            className="text-sm text-accent hover:underline"
          >
            View Your Profile
          </Link>
        )}
      </div>

      {householdMembers.length > 1 && (
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs text-muted uppercase tracking-wide mb-3">
            Household Profiles
          </div>
          <div className="flex flex-wrap gap-2">
            {householdMembers.map((member) => {
              const active = member.id === stats.user.id;
              return (
                <Link
                  key={member.id}
                  href={`/profile?userId=${member.id}`}
                  className={`px-3 py-2 rounded-lg border text-sm transition-colors ${
                    active
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-border text-foreground hover:bg-card-hover"
                  }`}
                >
                  {member.name}
                  <span className="ml-2 text-xs text-muted">{member.ratingCount}</span>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* ML Model Status */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-8 h-8 bg-accent-soft rounded-lg flex items-center justify-center">
            <svg
              className="w-4 h-4 text-accent"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
          </div>
          <h3 className="font-semibold">Recommendation Model</h3>
          {stats.mlModel?.isTraining && (
            <span className="text-xs bg-accent/20 text-accent px-2 py-0.5 rounded-full animate-pulse">
              Training...
            </span>
          )}
        </div>
        {stats.mlModel ? (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
              <div>
                <div className="text-xs text-muted mb-1">Confidence</div>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-2 bg-border rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        stats.mlModel.confidence > 0.7
                          ? "bg-success"
                          : stats.mlModel.confidence > 0.3
                            ? "bg-warning"
                            : "bg-error"
                      }`}
                      style={{ width: `${stats.mlModel.confidence * 100}%` }}
                    />
                  </div>
                  <span className="text-sm font-medium">
                    {(stats.mlModel.confidence * 100).toFixed(0)}%
                  </span>
                </div>
              </div>
              <div>
                <div className="text-xs text-muted mb-1">Ratings</div>
                <div className="text-sm font-medium">{stats.mlModel.totalRatings}</div>
              </div>
              <div>
                <div className="text-xs text-muted mb-1">Features</div>
                <div className="text-sm font-medium">{stats.mlModel.featuresLearned}</div>
              </div>
              <div>
                <div className="text-xs text-muted mb-1">Epochs</div>
                <div className="text-sm font-medium">{stats.mlModel.trainedEpochs}</div>
              </div>
              <div>
                <div className="text-xs text-muted mb-1">Train RMSE</div>
                <div className="text-sm font-medium">
                  {stats.mlModel.rmse !== null
                    ? stats.mlModel.rmse.toFixed(3)
                    : "N/A"}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted mb-1">Val RMSE</div>
                <div className="text-sm font-medium">
                  {stats.mlModel.validationRmse !== null
                    ? stats.mlModel.validationRmse.toFixed(3)
                    : "N/A"}
                </div>
              </div>
            </div>
            {stats.mlModel.lastTrainedAt && (
              <div className="text-xs text-muted mt-3">
                Last trained:{" "}
                {new Date(stats.mlModel.lastTrainedAt).toLocaleString()}
              </div>
            )}
          </>
        ) : (
          <div className="text-sm text-muted">
            <p>
              Not trained yet. The model requires at least 20 movie ratings across all
              household members before it can learn your preferences.
            </p>
            <p className="mt-2">
              You have rated <span className="font-medium text-foreground">{stats.counts.moviesRated}</span> movies.
              {stats.counts.moviesRated < 20 && (
                <span> Rate {20 - stats.counts.moviesRated} more to enable personalized recommendations.</span>
              )}
            </p>
          </div>
        )}
      </div>

      {/* User Settings */}
      <div className="bg-card border border-border rounded-xl p-4">
        <h3 className="font-semibold mb-3">Discovery Settings</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-xs text-muted mb-1">Exploration Factor</div>
            <div className="flex items-center gap-2">
              <div className="flex-1 h-2 bg-border rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent rounded-full"
                  style={{ width: `${stats.user.explorationFactor * 100}%` }}
                />
              </div>
              <span className="text-sm font-medium">
                {(stats.user.explorationFactor * 100).toFixed(0)}%
              </span>
            </div>
            <div className="text-xs text-muted mt-1">
              {stats.user.explorationFactor < 0.3
                ? "Prefers safe choices"
                : stats.user.explorationFactor > 0.7
                  ? "Adventurous explorer"
                  : "Balanced explorer"}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted mb-1">Discovery Preference</div>
            <div className="text-sm font-medium">
              {discoveryLabels[stats.user.discoverySourcePref] ||
                stats.user.discoverySourcePref}
            </div>
          </div>
        </div>
      </div>

      {/* Movie Personality */}
      {stats.moviePersonality && (
        <MoviePersonalityCard
          personality={stats.moviePersonality}
          canRate={canQuickRate}
          movieRatings={movieRatings}
          savingMovieIds={savingMovieIds}
          onRate={handleRateMovie}
          onToggleSeen={handleToggleSeen}
        />
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-2xl font-bold text-accent">
            {stats.counts.moviesRated}
          </div>
          <div className="text-xs text-muted">Movies Rated</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-2xl font-bold text-accent">
            {stats.counts.moviesSeen}
          </div>
          <div className="text-xs text-muted">Movies Seen</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-2xl font-bold text-accent">
            {stats.counts.genresRanked}
          </div>
          <div className="text-xs text-muted">Genres Ranked</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-2xl font-bold text-accent">
            {stats.counts.actorsRated}
          </div>
          <div className="text-xs text-muted">Actors Rated</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-2xl font-bold text-accent">
            {stats.counts.directorsRated}
          </div>
          <div className="text-xs text-muted">Directors Rated</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-2xl font-bold text-accent">
            {stats.counts.studiosRated}
          </div>
          <div className="text-xs text-muted">Studios Rated</div>
        </div>
      </div>

      {/* Rating Distribution */}
      {stats.ratingDistribution.some((d) => d.count > 0) && (
        <RatingDistribution distribution={stats.ratingDistribution} />
      )}

      {/* Affinity Sections */}
      <div className="grid gap-4 md:grid-cols-2">
        <AffinitySection
          title="Genres"
          topItems={stats.topGenres}
          bottomItems={stats.bottomGenres}
          icon={
            <svg
              className="w-4 h-4 text-accent"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M5 3l14 9-14 9V3z"
              />
            </svg>
          }
        />

        <AffinitySection
          title="Actors"
          topItems={stats.topActors}
          bottomItems={stats.bottomActors}
          icon={
            <svg
              className="w-4 h-4 text-accent"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
              />
            </svg>
          }
        />

        <AffinitySection
          title="Directors"
          topItems={stats.topDirectors}
          bottomItems={stats.bottomDirectors}
          icon={
            <svg
              className="w-4 h-4 text-accent"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
          }
        />

        <AffinitySection
          title="Studios"
          topItems={stats.topStudios}
          bottomItems={stats.bottomStudios}
          icon={
            <svg
              className="w-4 h-4 text-accent"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
              />
            </svg>
          }
        />
      </div>

      {/* Recent High-Rated Movies */}
      {stats.recentHighRatedMovies.length > 0 && (
        <div className="bg-card border border-border rounded-xl p-4">
          <h3 className="font-semibold mb-4">Recent Favorites</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
            {stats.recentHighRatedMovies.map((movie) => (
              <ProfileMovieCard
                key={movie.id}
                movie={{ id: movie.id, title: movie.title, year: movie.year, posterUrl: movie.posterUrl }}
                canRate={canQuickRate}
                ratingState={movieRatings[movie.id] ?? { rating: null, hasSeen: false, notHeardOf: false }}
                isSaving={Boolean(savingMovieIds[movie.id])}
                onRate={handleRateMovie}
                onToggleSeen={handleToggleSeen}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
export default function ProfilePage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64"><div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" /></div>}>
      <ProfilePageContent />
    </Suspense>
  );
}
