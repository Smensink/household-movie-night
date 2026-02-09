"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useSession } from "next-auth/react";
import { useRouter, useParams } from "next/navigation";
import GenreRanker from "@/components/GenreRanker";
import SessionVoteCard from "@/components/SessionVoteCard";
import Button from "@/components/ui/Button";

interface Genre {
  id: string;
  name: string;
  slug: string;
}

interface SessionMovie {
  id: string;
  movieId: string;
  movie: {
    id: string;
    title: string;
    year?: number | null;
    posterUrl?: string | null;
    overview?: string | null;
    genres: { genre: { name: string } }[];
    plexAvailability?: { available: boolean } | null;
    radarrSync?: { available: boolean } | null;
    cast?: { person: { name: string } }[];
    crew?: { job: string; person: { name: string } }[];
    studios?: { studio: { name: string } }[];
    ratings?: { hasSeen: boolean }[];
  };
  votes: {
    userId: string;
    rating: number;
    willingToRewatch: boolean;
    user: { name: string };
  }[];
}

interface SessionData {
  id: string;
  status: string;
  guestInviteCode: string;
  decidedMovieId: string | null;
  canManage?: boolean;
  participants: {
    userId: string;
    minReleaseYear?: number | null;
    maxReleaseYear?: number | null;
    okWithRewatch?: boolean;
    user: { name: string };
  }[];
}

type Step = "preferences" | "voting" | "reviewing" | "decided";

const VOTES_BEFORE_LEADERBOARD = 8; // Show leaderboard after rating all movies

function calculateDecisionScore(votes: SessionMovie["votes"]): number {
  if (votes.length === 0) return 0;
  const avgRating = votes.reduce((sum, vote) => sum + vote.rating, 0) / votes.length;
  const minRating = Math.min(...votes.map((vote) => vote.rating));
  return avgRating * 0.6 + minRating * 0.4;
}

export default function SessionPage() {
  const YEAR_MIN = 1950;
  const YEAR_MAX = new Date().getFullYear() + 1;
  const { data: session, status: authStatus } = useSession();
  const router = useRouter();
  const params = useParams();
  const sessionId = params.id as string;

  const [sessionData, setSessionData] = useState<SessionData | null>(null);
  const [genres, setGenres] = useState<Genre[]>([]);
  const [sessionMovies, setSessionMovies] = useState<SessionMovie[]>([]);
  const [step, setStep] = useState<Step>("preferences");
  const [minReleaseYear, setMinReleaseYear] = useState(1990);
  const [maxReleaseYear, setMaxReleaseYear] = useState(new Date().getFullYear());
  const [okWithRewatch, setOkWithRewatch] = useState(true);
  const [votes, setVotes] = useState<
    Map<string, { rating: number; willingToRewatch: boolean }>
  >(new Map());
  const [explorationFactor, setExplorationFactor] = useState(0.5);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [decidedMovie, setDecidedMovie] = useState<{
    title: string;
    year?: number | null;
    posterUrl?: string | null;
    score: number;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [endingSession, setEndingSession] = useState(false);
  const [editingRatings, setEditingRatings] = useState(false);
  const guestAuth = useMemo(() => {
    if (typeof window === "undefined") {
      return { ready: false, token: null as string | null, userId: null as string | null };
    }

    const storedGuestToken = sessionStorage.getItem("guestToken");
    const storedGuestSessionId = sessionStorage.getItem("guestSessionId");
    const storedGuestUserId = sessionStorage.getItem("guestUserId");

    if (storedGuestToken && storedGuestSessionId === sessionId) {
      return { ready: true, token: storedGuestToken, userId: storedGuestUserId };
    }

    return { ready: true, token: null as string | null, userId: null as string | null };
  }, [sessionId]);
  const guestToken = guestAuth.token;
  const guestUserId = guestAuth.userId;
  const guestReady = guestAuth.ready;

  useEffect(() => {
    if (authStatus === "unauthenticated" && guestReady && !guestToken) {
      router.push("/login");
    }
  }, [authStatus, guestReady, guestToken, router]);

  // Load session data
  useEffect(() => {
    if (authStatus === "loading") return;
    if (authStatus === "unauthenticated" && !guestReady) return;
    if (authStatus === "unauthenticated" && !guestToken) return;

    const guestHeader = guestToken ? { "x-guest-token": guestToken } : undefined;

    Promise.all([
      fetch(`/api/sessions/${sessionId}`, {
        headers: guestHeader,
      }).then((r) => r.json()),
      fetch("/api/genres", {
        headers: guestHeader,
      }).then((r) => r.json()),
      fetch(`/api/sessions/${sessionId}/movies`, {
        headers: guestHeader,
      }).then((r) => r.json()),
      authStatus === "authenticated"
        ? fetch("/api/settings").then((r) => r.json())
        : Promise.resolve(null),
    ]).then(([sess, genreData, movies, settingsData]) => {
      const parsedMovies: SessionMovie[] = Array.isArray(movies) ? movies : [];
      const activeUserId = session?.user?.id || guestUserId;

      if (settingsData?.explorationFactor !== undefined) {
        setExplorationFactor(settingsData.explorationFactor);
      }
      setSessionData(sess?.id ? sess : null);
      setGenres(genreData.genres || []);
      setSessionMovies(parsedMovies);
      if (activeUserId) {
        const participant = sess?.participants?.find(
          (candidate: { userId: string }) => candidate.userId === activeUserId
        );
        if (
          participant &&
          typeof participant.minReleaseYear === "number" &&
          typeof participant.maxReleaseYear === "number"
        ) {
          setMinReleaseYear(participant.minReleaseYear);
          setMaxReleaseYear(participant.maxReleaseYear);
        }
        if (participant && typeof participant.okWithRewatch === "boolean") {
          setOkWithRewatch(participant.okWithRewatch);
        }

        const existingVotes = new Map<
          string,
          { rating: number; willingToRewatch: boolean }
        >();
        for (const sessionMovie of parsedMovies) {
          const userVote = sessionMovie.votes.find(
            (vote) => vote.userId === activeUserId
          );
          if (userVote) {
            existingVotes.set(sessionMovie.id, {
              rating: userVote.rating,
              willingToRewatch: userVote.willingToRewatch,
            });
          }
        }
        setVotes(existingVotes);
      }

      if (sess?.status === "decided") {
        setStep("decided");
        const decidedSessionMovie = parsedMovies.find(
          (sessionMovie) => sessionMovie.movieId === sess.decidedMovieId
        );
        if (decidedSessionMovie) {
          setDecidedMovie({
            title: decidedSessionMovie.movie.title,
            year: decidedSessionMovie.movie.year,
            posterUrl: decidedSessionMovie.movie.posterUrl,
            score: calculateDecisionScore(decidedSessionMovie.votes),
          });
        }
      } else if (sess?.status === "voting" || parsedMovies.length > 0) {
        setStep("voting");
        setDecidedMovie(null);
      }
      setLoading(false);
    }).catch(() => {
      setLoading(false);
    });
  }, [authStatus, guestReady, guestToken, guestUserId, sessionId, session?.user?.id]);

  const savePreferences = async (
    genreRankings: { genreId: string; rank: number }[]
  ) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (guestToken) {
      headers["x-guest-token"] = guestToken;
    }

    await fetch(`/api/sessions/${sessionId}/preferences`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        minReleaseYear,
        maxReleaseYear,
        okWithRewatch,
        genreRankings,
      }),
    });
  };

  const generateMovies = async () => {
    setGenerating(true);
    const headers: Record<string, string> = {};
    if (guestToken) {
      headers["x-guest-token"] = guestToken;
    }

    // Save current exploration factor before generating
    if (authStatus === "authenticated") {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ explorationFactor }),
      });
    }
    const res = await fetch(`/api/sessions/${sessionId}/movies`, {
      method: "POST",
      headers,
    });
    if (res.ok) {
      const movies = await res.json();
      setSessionMovies(movies);
      setStep("voting");
    }
    setGenerating(false);
  };

  const handleVote = useCallback(
    (sessionMovieId: string, rating: number) => {
      setVotes((prev) => {
        const next = new Map(prev);
        const existing = next.get(sessionMovieId) || {
          rating: 0,
          willingToRewatch: false,
        };
        next.set(sessionMovieId, { ...existing, rating });
        return next;
      });
    },
    []
  );

  const handleRewatchToggle = useCallback(
    (sessionMovieId: string, willing: boolean) => {
      setVotes((prev) => {
        const next = new Map(prev);
        const existing = next.get(sessionMovieId) || {
          rating: 0,
          willingToRewatch: false,
        };
        next.set(sessionMovieId, { ...existing, willingToRewatch: willing });
        return next;
      });
    },
    []
  );

  const submitVotes = async () => {
    const voteArray = Array.from(votes.entries()).map(([sessionMovieId, v]) => ({
      sessionMovieId,
      rating: v.rating,
      willingToRewatch: v.willingToRewatch,
    }));

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (guestToken) {
      headers["x-guest-token"] = guestToken;
    }

    await fetch(`/api/sessions/${sessionId}/vote`, {
      method: "POST",
      headers,
      body: JSON.stringify({ votes: voteArray }),
    });
  };

  const refreshMovies = async () => {
    const headers: Record<string, string> = {};
    if (guestToken) {
      headers["x-guest-token"] = guestToken;
    }

    const res = await fetch(`/api/sessions/${sessionId}/movies`, {
      headers,
    });
    if (res.ok) {
      const movies = await res.json();
      setSessionMovies(Array.isArray(movies) ? movies : []);
    }
  };

  const goToReview = async () => {
    await submitVotes();
    await refreshMovies();
    setStep("reviewing");
  };

  const goBackToVoting = () => {
    setEditingRatings(true);
    setStep("voting");
  };

  const decideMovie = async () => {
    setDeciding(true);

    // Only submit votes if we haven't already (coming from voting step)
    if (step === "voting") {
      await submitVotes();
    }

    const headers: Record<string, string> = {};
    if (guestToken) {
      headers["x-guest-token"] = guestToken;
    }

    const res = await fetch(`/api/sessions/${sessionId}/decide`, {
      method: "POST",
      headers,
    });
    if (res.ok) {
      const result = await res.json();
      setDecidedMovie({
        title: result.movie.title,
        year: result.movie.year,
        posterUrl: result.movie.posterUrl,
        score: result.score,
      });
      setStep("decided");
    }
    setDeciding(false);
  };

  const copyGuestLink = () => {
    if (!sessionData) return;
    const link = `${window.location.origin}/join/${sessionData.guestInviteCode}`;
    navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const endSession = async () => {
    if (!sessionData?.canManage) return;
    const confirmed = window.confirm(
      "End this movie night session now? Participants will stop being able to vote."
    );
    if (!confirmed) return;

    setEndingSession(true);
    
    const headers: Record<string, string> = {};
    if (guestToken) {
      headers["x-guest-token"] = guestToken;
    }
    
    try {
      const response = await fetch(`/api/sessions/${sessionId}`, {
        method: "DELETE",
        headers,
      });
      
      if (response.ok) {
        router.push("/dashboard");
      } else {
        const errorData = await response.json().catch(() => ({ error: "Unknown error" }));
        alert(`Failed to end session: ${errorData.error || response.statusText}`);
      }
    } catch {
      alert("Network error while ending session. Please try again.");
    } finally {
      setEndingSession(false);
    }
  };

  if (authStatus === "loading" || loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!sessionData) {
    return (
      <div className="text-center py-12">
        <p className="text-sm text-muted">Session not found</p>
      </div>
    );
  }

  if (sessionData.status === "cancelled") {
    return (
      <div className="text-center py-12 space-y-4">
        <h1 className="text-2xl font-bold">Session Ended</h1>
        <p className="text-sm text-muted">
          This movie night was ended before a final movie was selected.
        </p>
        <Button variant="secondary" onClick={() => router.push("/dashboard")}>
          Back to Dashboard
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Movie Night</h1>
          <div className="flex items-center gap-2 mt-1">
            {sessionData.participants.map((p) => (
              <span
                key={p.userId}
                className="text-[11px] bg-accent-soft text-accent px-2 py-0.5 rounded-full"
              >
                {p.user.name}
              </span>
            ))}
          </div>
          <p className="text-[11px] text-muted mt-1">
            Session token:{" "}
            <code className="bg-card-hover border border-border rounded px-1.5 py-0.5 text-foreground">
              {sessionData.guestInviteCode}
            </code>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={copyGuestLink}
            className="text-xs text-accent hover:underline"
          >
            {copied ? "Copied!" : "Invite Guest"}
          </button>
          {sessionData.canManage && (
            <Button
              size="sm"
              variant="danger"
              onClick={endSession}
              loading={endingSession}
            >
              End Session
            </Button>
          )}
        </div>
      </div>

      {/* Steps indicator */}
      <div className="flex items-center gap-2">
        {(["preferences", "voting", "reviewing", "decided"] as Step[]).map((s, i) => {
          const stepLabels = { preferences: "Preferences", voting: "Rate", reviewing: "Leaderboard", decided: "Watch" };
          const allSteps = ["preferences", "voting", "reviewing", "decided"];
          return (
            <div key={s} className="flex items-center gap-2 flex-1">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                  step === s
                    ? "bg-accent text-white"
                    : allSteps.indexOf(s) < allSteps.indexOf(step)
                    ? "bg-success text-white"
                    : "bg-card-hover text-muted"
                }`}
              >
                {i + 1}
              </div>
              <span className="text-[11px] text-muted hidden sm:block">
                {stepLabels[s]}
              </span>
              {i < 3 && (
                <div className="flex-1 h-px bg-border" />
              )}
            </div>
          );
        })}
      </div>

      {/* Step: Preferences */}
      {step === "preferences" && (
        <div className="space-y-6 animate-slide-up">
          {/* Release year preference */}
          <div>
            <h3 className="text-sm font-semibold mb-2">Choose your release year range</h3>
            <div className="bg-card border border-border rounded-xl p-4 space-y-4">
              <div className="flex items-center justify-center gap-2 text-sm">
                <span className="font-semibold text-accent text-lg">{minReleaseYear}</span>
                <span className="text-muted">-</span>
                <span className="font-semibold text-accent text-lg">{maxReleaseYear}</span>
              </div>
              
              {/* Dual handle range slider */}
              <div
                className="relative h-10 touch-none select-none"
                onPointerDown={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const percent = (e.clientX - rect.left) / rect.width;
                  const yearAtClick = Math.round(YEAR_MIN + percent * (YEAR_MAX - YEAR_MIN));

                  // Determine which handle is closer
                  const distToMin = Math.abs(yearAtClick - minReleaseYear);
                  const distToMax = Math.abs(yearAtClick - maxReleaseYear);
                  const targetHandle = distToMin <= distToMax ? 'min' : 'max';

                  const updateValue = (clientX: number) => {
                    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                    const year = Math.round(YEAR_MIN + pct * (YEAR_MAX - YEAR_MIN));

                    if (targetHandle === 'min') {
                      if (year <= maxReleaseYear - 5 && year >= YEAR_MIN) {
                        setMinReleaseYear(year);
                      }
                    } else {
                      if (year >= minReleaseYear + 5 && year <= YEAR_MAX) {
                        setMaxReleaseYear(year);
                      }
                    }
                  };

                  updateValue(e.clientX);

                  const onMove = (moveEvent: PointerEvent) => {
                    updateValue(moveEvent.clientX);
                  };

                  const onUp = () => {
                    window.removeEventListener('pointermove', onMove);
                    window.removeEventListener('pointerup', onUp);
                  };

                  window.addEventListener('pointermove', onMove);
                  window.addEventListener('pointerup', onUp);
                }}
              >
                {/* Track background */}
                <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-2 bg-border rounded-full" />
                {/* Active range */}
                <div
                  className="absolute top-1/2 -translate-y-1/2 h-2 bg-accent rounded-full"
                  style={{
                    left: `${((minReleaseYear - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 100}%`,
                    right: `${100 - ((maxReleaseYear - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 100}%`,
                  }}
                />
                {/* Min handle */}
                <div
                  className="absolute top-1/2 -translate-y-1/2 w-6 h-6 bg-accent rounded-full shadow-lg border-2 border-background cursor-grab active:cursor-grabbing transition-transform hover:scale-110"
                  style={{ left: `calc(${((minReleaseYear - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 100}% - 12px)` }}
                />
                {/* Max handle */}
                <div
                  className="absolute top-1/2 -translate-y-1/2 w-6 h-6 bg-accent rounded-full shadow-lg border-2 border-background cursor-grab active:cursor-grabbing transition-transform hover:scale-110"
                  style={{ left: `calc(${((maxReleaseYear - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 100}% - 12px)` }}
                />
              </div>
              
              <div className="flex justify-between text-[10px] text-muted px-1">
                <span>{YEAR_MIN}</span>
                <span>{YEAR_MAX}</span>
              </div>
              
              <p className="text-[11px] text-muted">
                Drag either handle to adjust your preferred release year range. Movies outside this range are less likely to be suggested.
              </p>
            </div>
          </div>

          {/* Rewatch preference */}
          <div>
            <h3 className="text-sm font-semibold mb-2">Rewatch preference</h3>
            <div className="bg-card border border-border rounded-xl p-4">
              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <p className="text-sm font-medium">Open to rewatching movies</p>
                  <p className="text-[11px] text-muted mt-0.5">
                    Would you be okay watching a movie you&apos;ve already seen?
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={okWithRewatch}
                  onClick={() => setOkWithRewatch(!okWithRewatch)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    okWithRewatch ? "bg-accent" : "bg-border"
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      okWithRewatch ? "translate-x-6" : "translate-x-1"
                    }`}
                  />
                </button>
              </label>
            </div>
          </div>

          {/* Genre ranking for tonight */}
          {genres.length > 0 && (
            <GenreRanker
              genres={genres}
              onSave={async (rankings) => {
                await savePreferences(rankings);
                await generateMovies();
              }}
              saving={generating}
              title="Rank genres for tonight"
            />
          )}

          {genres.length === 0 && (
            <Button onClick={generateMovies} loading={generating} className="w-full" size="lg">
              Generate Movie Picks
            </Button>
          )}
        </div>
      )}

      {/* Step: Voting */}
      {step === "voting" && (
        <div className="space-y-4 animate-slide-up">
          <div>
            <h3 className="text-lg font-semibold">Vote on Movies</h3>
            <p className="text-xs text-muted">
              Rate each movie for how willing you are to watch it tonight.
              {session?.user?.name && ` (Voting as ${session.user.name})`}
            </p>
          </div>

          {/* Inline exploration slider */}
          <div className="bg-card border border-border rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-muted">Familiar</span>
              <span className="text-[10px] font-medium text-accent">
                {explorationFactor <= 0.3
                  ? "Comfort picks"
                  : explorationFactor <= 0.7
                  ? "Balanced"
                  : "Adventurous"}
              </span>
              <span className="text-[11px] text-muted">Explore</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={explorationFactor}
              onChange={(e) =>
                setExplorationFactor(parseFloat(e.target.value))
              }
              className="w-full h-1.5 bg-border rounded-lg appearance-none cursor-pointer accent-accent"
            />
            <button
              onClick={generateMovies}
              disabled={generating}
              className="text-[11px] text-accent hover:underline"
            >
              {generating ? "Regenerating..." : "Regenerate picks with new setting"}
            </button>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {sessionMovies.map((sm) => {
              const vote = votes.get(sm.id);
              const available =
                sm.movie.plexAvailability?.available ||
                sm.movie.radarrSync?.available ||
                false;
              const directors = Array.from(
                new Set(
                  (sm.movie.crew || [])
                    .filter((member) => member.job.toLowerCase() === "director")
                    .map((member) => member.person.name)
                    .filter(Boolean)
                )
              ).slice(0, 2);
              const actors = Array.from(
                new Set(
                  (sm.movie.cast || [])
                    .map((member) => member.person.name)
                    .filter(Boolean)
                )
              ).slice(0, 3);
              const studios = Array.from(
                new Set(
                  (sm.movie.studios || [])
                    .map((member) => member.studio.name)
                    .filter(Boolean)
                )
              ).slice(0, 2);
              const userHasSeen = Boolean(sm.movie.ratings?.[0]?.hasSeen);

              return (
                <SessionVoteCard
                  key={sm.id}
                  movie={{
                    ...sm.movie,
                    directors,
                    actors,
                    studios,
                  }}
                  sessionMovieId={sm.id}
                  userHasSeen={userHasSeen}
                  rating={vote?.rating ?? null}
                  willingToRewatch={vote?.willingToRewatch ?? false}
                  onRate={(rating) => handleVote(sm.id, rating)}
                  onRewatchToggle={(willing) =>
                    handleRewatchToggle(sm.id, willing)
                  }
                  available={available}
                />
              );
            })}
          </div>

          <Button
            size="lg"
            className="w-full"
            onClick={goToReview}
            disabled={votes.size < sessionMovies.length}
          >
            {votes.size < sessionMovies.length
              ? `Rate all ${sessionMovies.length} movies to continue`
              : "View Leaderboard"
            }
          </Button>
          {editingRatings && (
            <Button
              variant="secondary"
              size="lg"
              className="w-full"
              onClick={goToReview}
            >
              Done Editing
            </Button>
          )}
        </div>
      )}

      {/* Step: Reviewing (Leaderboard) */}
      {step === "reviewing" && (
        <div className="space-y-6 animate-slide-up">
          <div>
            <h3 className="text-lg font-semibold">Leaderboard</h3>
            <p className="text-xs text-muted">
              See how everyone voted. You can edit your ratings before the final decision.
            </p>
          </div>

          {/* Participant legend */}
          <div className="flex flex-wrap gap-2">
            {sessionData.participants.map((p) => (
              <div
                key={p.userId}
                className="flex items-center gap-1.5 text-xs bg-card border border-border rounded-full px-2.5 py-1"
              >
                <span className="w-2 h-2 rounded-full bg-accent" />
                <span>{p.user.name}</span>
              </div>
            ))}
          </div>

          {/* Leaderboard */}
          <div className="space-y-3">
            {sessionMovies
              .map((sm) => ({
                ...sm,
                score: calculateDecisionScore(sm.votes),
                avgRating: sm.votes.length > 0
                  ? sm.votes.reduce((sum, v) => sum + v.rating, 0) / sm.votes.length
                  : 0,
                minRating: sm.votes.length > 0
                  ? Math.min(...sm.votes.map((v) => v.rating))
                  : 0,
              }))
              .sort((a, b) => b.score - a.score)
              .map((sm, rank) => {
                const available =
                  sm.movie.plexAvailability?.available ||
                  sm.movie.radarrSync?.available ||
                  false;
                const activeUserId = session?.user?.id || guestUserId;
                const userVote = sm.votes.find((v) => v.userId === activeUserId);

                return (
                  <div
                    key={sm.id}
                    className={`bg-card border rounded-xl p-4 ${
                      rank === 0 ? "border-accent ring-1 ring-accent/30" : "border-border"
                    }`}
                  >
                    <div className="flex gap-4">
                      {/* Rank badge */}
                      <div className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-lg font-bold ${
                        rank === 0 ? "bg-accent text-white" :
                        rank === 1 ? "bg-card-hover text-foreground" :
                        rank === 2 ? "bg-card-hover text-muted" :
                        "bg-card-hover text-muted"
                      }`}>
                        {rank === 0 ? "🏆" : `#${rank + 1}`}
                      </div>

                      {/* Poster */}
                      <div className="flex-shrink-0 w-16 h-24 rounded-lg overflow-hidden bg-card-hover">
                        {sm.movie.posterUrl ? (
                          <img
                            src={sm.movie.posterUrl}
                            alt={sm.movie.title}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-muted text-xs">
                            No poster
                          </div>
                        )}
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <h4 className="font-semibold text-sm truncate">
                              {sm.movie.title}
                              {sm.movie.year && (
                                <span className="text-muted font-normal ml-1">
                                  ({sm.movie.year})
                                </span>
                              )}
                            </h4>
                            <div className="flex items-center gap-2 mt-1">
                              {available && (
                                <span className="text-[10px] bg-success/15 text-success px-1.5 py-0.5 rounded-full">
                                  Available
                                </span>
                              )}
                              <span className="text-xs text-muted">
                                Score: <span className="font-semibold text-accent">{sm.score.toFixed(1)}</span>
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Participant votes */}
                        <div className="mt-3 flex flex-wrap gap-2">
                          {sessionData.participants.map((p) => {
                            const vote = sm.votes.find((v) => v.userId === p.userId);
                            return (
                              <div
                                key={p.userId}
                                className="flex items-center gap-1 text-xs bg-card-hover rounded-full px-2 py-1"
                              >
                                <span className="text-muted">{p.user.name}:</span>
                                {vote ? (
                                  <span className="font-semibold">
                                    {"★".repeat(vote.rating)}
                                    <span className="text-muted">{"★".repeat(5 - vote.rating)}</span>
                                  </span>
                                ) : (
                                  <span className="text-muted italic">pending</span>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        {/* Your vote highlight */}
                        {userVote && (
                          <div className="mt-2 text-xs text-muted">
                            Your vote: <span className="text-accent font-semibold">{userVote.rating}/5</span>
                            {userVote.willingToRewatch && (
                              <span className="ml-2 text-success">✓ Would rewatch</span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>

          {/* Action buttons */}
          <div className="flex gap-3">
            <Button
              variant="secondary"
              size="lg"
              className="flex-1"
              onClick={goBackToVoting}
            >
              Edit My Ratings
            </Button>
            <Button
              size="lg"
              className="flex-1"
              onClick={decideMovie}
              loading={deciding}
            >
              Finalize Decision
            </Button>
          </div>

          <p className="text-[11px] text-muted text-center">
            The movie with the highest consensus score (60% average + 40% minimum rating) will be selected.
          </p>
        </div>
      )}

      {/* Step: Decided */}
      {step === "decided" && decidedMovie && (
        <div className="text-center space-y-6 py-8 animate-slide-up">
          <div className="w-20 h-20 mx-auto bg-success/15 rounded-full flex items-center justify-center">
            <svg className="w-10 h-10 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>

          <div>
            <p className="text-sm text-muted mb-2">Tonight you&apos;re watching</p>
            <h2 className="text-3xl font-bold glow-pulse inline-block px-4 py-2 rounded-2xl">
              {decidedMovie.title}
            </h2>
            {decidedMovie.year && (
              <p className="text-sm text-muted mt-1">({decidedMovie.year})</p>
            )}
          </div>

          <div className="bg-card border border-border rounded-xl p-4 inline-block">
            <div className="text-sm text-muted">Consensus Score</div>
            <div className="text-2xl font-bold text-accent">
              {decidedMovie.score.toFixed(1)}/5
            </div>
          </div>

          <Button
            variant="secondary"
            onClick={() => router.push("/dashboard")}
            className="mt-4"
          >
            Back to Dashboard
          </Button>
        </div>
      )}
    </div>
  );
}
