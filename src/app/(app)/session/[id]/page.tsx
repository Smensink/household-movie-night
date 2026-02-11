"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useSession } from "next-auth/react";
import { useRouter, useParams } from "next/navigation";
import Image from "next/image";
import GenreRanker from "@/components/GenreRanker";
import SessionVoteCard from "@/components/SessionVoteCard";
import StarRating from "@/components/StarRating";
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

const QUEUE_MIN_ITEMS = 6;
const QUEUE_REPLENISH_BATCH = 8;
const QUEUE_REFRESH_MS = 8000;
const LEADERBOARD_MIN_VOTES_BASE = 8;

function calculateDecisionScore(votes: SessionMovie["votes"]): number {
  if (votes.length === 0) return 0;
  const avgRating = votes.reduce((sum, vote) => sum + vote.rating, 0) / votes.length;
  const minRating = Math.min(...votes.map((vote) => vote.rating));
  return avgRating * 0.6 + minRating * 0.4;
}

function extractMovieMeta(movie: SessionMovie["movie"]) {
  const directors = Array.from(
    new Set(
      (movie.crew || [])
        .filter((member) => member.job.toLowerCase() === "director")
        .map((member) => member.person.name)
        .filter(Boolean)
    )
  ).slice(0, 2);

  const actors = Array.from(
    new Set((movie.cast || []).map((member) => member.person.name).filter(Boolean))
  ).slice(0, 3);

  const studios = Array.from(
    new Set((movie.studios || []).map((member) => member.studio.name).filter(Boolean))
  ).slice(0, 2);

  return { directors, actors, studios };
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
  const [allSessionMovies, setAllSessionMovies] = useState<SessionMovie[]>([]);
  const [queueMovies, setQueueMovies] = useState<SessionMovie[]>([]);
  const [step, setStep] = useState<Step>("preferences");
  const [minReleaseYear, setMinReleaseYear] = useState(1990);
  const [maxReleaseYear, setMaxReleaseYear] = useState(new Date().getFullYear());
  const [okWithRewatch, setOkWithRewatch] = useState(true);
  const [votes, setVotes] = useState<
    Map<string, { rating: number; willingToRewatch: boolean }>
  >(new Map());
  const [rewatchDrafts, setRewatchDrafts] = useState<Map<string, boolean>>(
    new Map()
  );
  const [explorationFactor, setExplorationFactor] = useState(0.5);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [submittingVoteFor, setSubmittingVoteFor] = useState<string | null>(null);
  const [voteError, setVoteError] = useState<string | null>(null);
  const [decidedMovie, setDecidedMovie] = useState<{
    title: string;
    year?: number | null;
    posterUrl?: string | null;
    score: number;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [endingSession, setEndingSession] = useState(false);

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
  const activeUserId = session?.user?.id || guestUserId || null;
  const activeUserName =
    session?.user?.name ||
    (activeUserId
      ? sessionData?.participants.find((participant) => participant.userId === activeUserId)
          ?.user.name
      : null) ||
    "Guest";

  const buildHeaders = useCallback(
    (json = false): Record<string, string> => {
      const headers: Record<string, string> = {};
      if (guestToken) {
        headers["x-guest-token"] = guestToken;
      }
      if (json) {
        headers["Content-Type"] = "application/json";
      }
      return headers;
    },
    [guestToken]
  );

  const hydrateVotesFromMovies = useCallback(
    (movies: SessionMovie[]) => {
      if (!activeUserId) return;
      const next = new Map<string, { rating: number; willingToRewatch: boolean }>();
      for (const sessionMovie of movies) {
        const userVote = sessionMovie.votes.find((vote) => vote.userId === activeUserId);
        if (userVote) {
          next.set(sessionMovie.id, {
            rating: userVote.rating,
            willingToRewatch: userVote.willingToRewatch,
          });
        }
      }
      setVotes(next);
    },
    [activeUserId]
  );

  const refreshSessionMovies = useCallback(async () => {
    const res = await fetch(`/api/sessions/${sessionId}/movies`, {
      headers: buildHeaders(),
    });
    if (!res.ok) return;

    const movies = await res.json();
    const parsedMovies: SessionMovie[] = Array.isArray(movies) ? movies : [];
    setAllSessionMovies(parsedMovies);
    hydrateVotesFromMovies(parsedMovies);
  }, [buildHeaders, hydrateVotesFromMovies, sessionId]);

  const refreshQueue = useCallback(async () => {
    const searchParams = new URLSearchParams({
      mode: "queue",
      minQueue: String(QUEUE_MIN_ITEMS),
      replenishBatch: String(QUEUE_REPLENISH_BATCH),
    });

    const res = await fetch(`/api/sessions/${sessionId}/movies?${searchParams.toString()}`, {
      headers: buildHeaders(),
    });
    if (!res.ok) return;

    const movies = await res.json();
    setQueueMovies(Array.isArray(movies) ? movies : []);
  }, [buildHeaders, sessionId]);

  const applyVoteLocally = useCallback(
    (sessionMovieId: string, rating: number, willingToRewatch: boolean) => {
      if (!activeUserId) return;

      setVotes((prev) => {
        const next = new Map(prev);
        next.set(sessionMovieId, { rating, willingToRewatch });
        return next;
      });

      const applyToCollection = (movies: SessionMovie[]) =>
        movies.map((movie) => {
          if (movie.id !== sessionMovieId) return movie;

          const otherVotes = movie.votes.filter((vote) => vote.userId !== activeUserId);
          return {
            ...movie,
            votes: [
              ...otherVotes,
              {
                userId: activeUserId,
                rating,
                willingToRewatch,
                user: { name: activeUserName },
              },
            ],
          };
        });

      setAllSessionMovies((prev) => applyToCollection(prev));
      setQueueMovies((prev) => applyToCollection(prev));
    },
    [activeUserId, activeUserName]
  );

  const persistVote = useCallback(
    async (sessionMovieId: string, rating: number, willingToRewatch: boolean) => {
      const res = await fetch(`/api/sessions/${sessionId}/vote`, {
        method: "POST",
        headers: buildHeaders(true),
        body: JSON.stringify({
          votes: [
            {
              sessionMovieId,
              rating,
              willingToRewatch,
            },
          ],
        }),
      });

      return res.ok;
    },
    [buildHeaders, sessionId]
  );

  const handleQueueVote = useCallback(
    async (sessionMovieId: string, rating: number) => {
      if (submittingVoteFor === sessionMovieId) return;

      setVoteError(null);
      const willingToRewatch =
        votes.get(sessionMovieId)?.willingToRewatch ??
        rewatchDrafts.get(sessionMovieId) ??
        false;
      applyVoteLocally(sessionMovieId, rating, willingToRewatch);
      setRewatchDrafts((prev) => {
        const next = new Map(prev);
        next.delete(sessionMovieId);
        return next;
      });
      setQueueMovies((prev) => prev.filter((movie) => movie.id !== sessionMovieId));
      setSubmittingVoteFor(sessionMovieId);

      const success = await persistVote(sessionMovieId, rating, willingToRewatch);
      await Promise.all([refreshSessionMovies(), refreshQueue()]);
      if (!success) {
        setVoteError("Could not save your vote. Please try again.");
      }

      setSubmittingVoteFor(null);
    },
    [
      applyVoteLocally,
      persistVote,
      refreshQueue,
      refreshSessionMovies,
      rewatchDrafts,
      submittingVoteFor,
      votes,
    ]
  );

  const handleRewatchToggle = useCallback(
    async (sessionMovieId: string, willing: boolean) => {
      const existing = votes.get(sessionMovieId);
      const existingRating = existing?.rating ?? null;

      if (!existingRating || existingRating < 1) {
        setRewatchDrafts((prev) => {
          const next = new Map(prev);
          next.set(sessionMovieId, willing);
          return next;
        });
        return;
      }

      setVotes((prev) => {
        const next = new Map(prev);
        next.set(sessionMovieId, {
          rating: existingRating,
          willingToRewatch: willing,
        });
        return next;
      });

      if (submittingVoteFor === sessionMovieId) return;
      setVoteError(null);
      applyVoteLocally(sessionMovieId, existingRating, willing);
      setSubmittingVoteFor(sessionMovieId);
      const success = await persistVote(sessionMovieId, existingRating, willing);
      await Promise.all([refreshSessionMovies(), refreshQueue()]);
      if (!success) {
        setVoteError("Could not update rewatch preference. Please try again.");
      }
      setSubmittingVoteFor(null);
    },
    [
      applyVoteLocally,
      persistVote,
      refreshQueue,
      refreshSessionMovies,
      submittingVoteFor,
      votes,
    ]
  );

  const generateMovies = useCallback(async () => {
    setGenerating(true);

    if (authStatus === "authenticated") {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ explorationFactor }),
      });
    }

    const res = await fetch(`/api/sessions/${sessionId}/movies`, {
      method: "POST",
      headers: buildHeaders(true),
      body: JSON.stringify({
        count: QUEUE_MIN_ITEMS + QUEUE_REPLENISH_BATCH,
        minQueue: QUEUE_MIN_ITEMS,
        replenishBatch: QUEUE_REPLENISH_BATCH,
      }),
    });

    if (res.ok) {
      const queue = await res.json();
      setQueueMovies(Array.isArray(queue) ? queue : []);
      setStep("voting");
      await refreshSessionMovies();
    }

    setGenerating(false);
  }, [authStatus, buildHeaders, explorationFactor, refreshSessionMovies, sessionId]);

  const savePreferences = async (genreRankings: { genreId: string; rank: number }[]) => {
    await fetch(`/api/sessions/${sessionId}/preferences`, {
      method: "POST",
      headers: buildHeaders(true),
      body: JSON.stringify({
        minReleaseYear,
        maxReleaseYear,
        okWithRewatch,
        genreRankings,
      }),
    });
  };

  const goToReview = useCallback(async () => {
    await refreshSessionMovies();
    setStep("reviewing");
  }, [refreshSessionMovies]);

  const goBackToVoting = useCallback(async () => {
    await Promise.all([refreshQueue(), refreshSessionMovies()]);
    setStep("voting");
  }, [refreshQueue, refreshSessionMovies]);

  const decideMovie = async () => {
    setDeciding(true);

    const res = await fetch(`/api/sessions/${sessionId}/decide`, {
      method: "POST",
      headers: buildHeaders(),
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

    try {
      const response = await fetch(`/api/sessions/${sessionId}`, {
        method: "DELETE",
        headers: buildHeaders(),
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

  useEffect(() => {
    if (authStatus === "unauthenticated" && guestReady && !guestToken) {
      router.push("/login");
    }
  }, [authStatus, guestReady, guestToken, router]);

  useEffect(() => {
    if (authStatus === "loading") return;
    if (authStatus === "unauthenticated" && !guestReady) return;
    if (authStatus === "unauthenticated" && !guestToken) return;

    Promise.all([
      fetch(`/api/sessions/${sessionId}`, { headers: buildHeaders() }).then((response) =>
        response.json()
      ),
      fetch("/api/genres", { headers: buildHeaders() }).then((response) => response.json()),
      fetch(`/api/sessions/${sessionId}/movies`, { headers: buildHeaders() }).then((response) =>
        response.json()
      ),
      authStatus === "authenticated"
        ? fetch("/api/settings").then((response) => response.json())
        : Promise.resolve(null),
    ])
      .then(([sess, genreData, movies, settingsData]) => {
        const parsedMovies: SessionMovie[] = Array.isArray(movies) ? movies : [];

        if (settingsData?.explorationFactor !== undefined) {
          setExplorationFactor(settingsData.explorationFactor);
        }

        setSessionData(sess?.id ? sess : null);
        setGenres(Array.isArray(genreData?.genres) ? genreData.genres : []);
        setAllSessionMovies(parsedMovies);

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
        }

        hydrateVotesFromMovies(parsedMovies);

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
      })
      .catch(() => {
        setLoading(false);
      });
  }, [
    activeUserId,
    authStatus,
    buildHeaders,
    guestReady,
    guestToken,
    hydrateVotesFromMovies,
    sessionId,
  ]);

  useEffect(() => {
    if (step !== "voting" || loading) return;
    void refreshQueue();
  }, [loading, refreshQueue, step]);

  useEffect(() => {
    if (step !== "voting") return;

    const interval = window.setInterval(() => {
      void refreshQueue();
      void refreshSessionMovies();
    }, QUEUE_REFRESH_MS);

    return () => window.clearInterval(interval);
  }, [refreshQueue, refreshSessionMovies, step]);

  const currentQueueMovie = queueMovies[0] ?? null;
  const queuePreview = queueMovies.slice(1, 4);

  const participantCount = sessionData?.participants.length ?? 1;
  const leaderboardMinTotalVotes = Math.max(
    LEADERBOARD_MIN_VOTES_BASE,
    participantCount * 4
  );
  const leaderboardMinUserVotes = Math.max(
    4,
    Math.ceil(leaderboardMinTotalVotes / Math.max(participantCount, 1))
  );

  const totalVotesCast = useMemo(
    () => allSessionMovies.reduce((sum, movie) => sum + movie.votes.length, 0),
    [allSessionMovies]
  );

  const userVotesCast = useMemo(() => {
    if (!activeUserId) return 0;
    return allSessionMovies.filter((movie) =>
      movie.votes.some((vote) => vote.userId === activeUserId)
    ).length;
  }, [activeUserId, allSessionMovies]);

  const canOpenLeaderboard =
    totalVotesCast >= leaderboardMinTotalVotes &&
    userVotesCast >= leaderboardMinUserVotes;

  const leaderboardRows = useMemo(
    () =>
      [...allSessionMovies]
        .map((movie) => ({
          ...movie,
          score: calculateDecisionScore(movie.votes),
        }))
        .sort((a, b) => b.score - a.score),
    [allSessionMovies]
  );

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Movie Night</h1>
          <div className="flex items-center gap-2 mt-1">
            {sessionData.participants.map((participant) => (
              <span
                key={participant.userId}
                className="text-[11px] bg-accent-soft text-accent px-2 py-0.5 rounded-full"
              >
                {participant.user.name}
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
          <button onClick={copyGuestLink} className="text-xs text-accent hover:underline">
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

      <div className="flex items-center gap-2">
        {(["preferences", "voting", "reviewing", "decided"] as Step[]).map((s, i) => {
          const stepLabels = {
            preferences: "Preferences",
            voting: "Rate",
            reviewing: "Leaderboard",
            decided: "Watch",
          };
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
              <span className="text-[11px] text-muted hidden sm:block">{stepLabels[s]}</span>
              {i < 3 && <div className="flex-1 h-px bg-border" />}
            </div>
          );
        })}
      </div>

      {step === "preferences" && (
        <div className="space-y-6 animate-slide-up">
          <div>
            <h3 className="text-sm font-semibold mb-2">Choose your release year range</h3>
            <div className="bg-card border border-border rounded-xl p-4 space-y-4">
              <div className="flex items-center justify-center gap-2 text-sm">
                <span className="font-semibold text-accent text-lg">{minReleaseYear}</span>
                <span className="text-muted">-</span>
                <span className="font-semibold text-accent text-lg">{maxReleaseYear}</span>
              </div>

              <div
                className="relative h-10 touch-none select-none"
                onPointerDown={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  const percent = (event.clientX - rect.left) / rect.width;
                  const yearAtClick = Math.round(YEAR_MIN + percent * (YEAR_MAX - YEAR_MIN));

                  const distToMin = Math.abs(yearAtClick - minReleaseYear);
                  const distToMax = Math.abs(yearAtClick - maxReleaseYear);
                  const targetHandle = distToMin <= distToMax ? "min" : "max";

                  const updateValue = (clientX: number) => {
                    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                    const year = Math.round(YEAR_MIN + pct * (YEAR_MAX - YEAR_MIN));

                    if (targetHandle === "min") {
                      if (year <= maxReleaseYear - 5 && year >= YEAR_MIN) {
                        setMinReleaseYear(year);
                      }
                    } else if (year >= minReleaseYear + 5 && year <= YEAR_MAX) {
                      setMaxReleaseYear(year);
                    }
                  };

                  updateValue(event.clientX);

                  const onMove = (moveEvent: PointerEvent) => {
                    updateValue(moveEvent.clientX);
                  };

                  const onUp = () => {
                    window.removeEventListener("pointermove", onMove);
                    window.removeEventListener("pointerup", onUp);
                  };

                  window.addEventListener("pointermove", onMove);
                  window.addEventListener("pointerup", onUp);
                }}
              >
                <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-2 bg-border rounded-full" />
                <div
                  className="absolute top-1/2 -translate-y-1/2 h-2 bg-accent rounded-full"
                  style={{
                    left: `${((minReleaseYear - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 100}%`,
                    right: `${100 - ((maxReleaseYear - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 100}%`,
                  }}
                />
                <div
                  className="absolute top-1/2 -translate-y-1/2 w-6 h-6 bg-accent rounded-full shadow-lg border-2 border-background cursor-grab active:cursor-grabbing transition-transform hover:scale-110"
                  style={{
                    left: `calc(${((minReleaseYear - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 100}% - 12px)`,
                  }}
                />
                <div
                  className="absolute top-1/2 -translate-y-1/2 w-6 h-6 bg-accent rounded-full shadow-lg border-2 border-background cursor-grab active:cursor-grabbing transition-transform hover:scale-110"
                  style={{
                    left: `calc(${((maxReleaseYear - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 100}% - 12px)`,
                  }}
                />
              </div>

              <div className="flex justify-between text-[10px] text-muted px-1">
                <span>{YEAR_MIN}</span>
                <span>{YEAR_MAX}</span>
              </div>

              <p className="text-[11px] text-muted">
                Drag either handle to adjust your preferred release year range. Movies outside
                this range are down-ranked.
              </p>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold mb-2">Rewatch preference</h3>
            <div className="bg-card border border-border rounded-xl p-4">
              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <p className="text-sm font-medium">Open to rewatching movies</p>
                  <p className="text-[11px] text-muted mt-0.5">
                    If off, movies you&apos;ve already seen are heavily deprioritized.
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
              Start Movie Queue
            </Button>
          )}
        </div>
      )}

      {step === "voting" && (
        <div className="space-y-4 animate-slide-up">
          <div>
            <h3 className="text-lg font-semibold">Continuous Movie Queue</h3>
            <p className="text-xs text-muted">
              The next movie is ranked by MF expected household rating, your tonight preferences,
              and live session momentum from other voters.
            </p>
          </div>

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
              onChange={(event) => setExplorationFactor(parseFloat(event.target.value))}
              className="w-full h-1.5 bg-border rounded-lg appearance-none cursor-pointer accent-accent"
            />
            <button
              onClick={generateMovies}
              disabled={generating}
              className="text-[11px] text-accent hover:underline"
            >
              {generating ? "Refreshing queue..." : "Refresh queue with this setting"}
            </button>
          </div>

          <div className="bg-card border border-border rounded-xl p-3 text-xs text-muted flex flex-wrap items-center gap-3">
            <span>
              Session votes processed: <span className="text-foreground font-semibold">{totalVotesCast}</span>
              /{leaderboardMinTotalVotes}
            </span>
            <span>
              Your votes: <span className="text-foreground font-semibold">{userVotesCast}</span>
              /{leaderboardMinUserVotes}
            </span>
            <span>
              Queue ready: <span className="text-foreground font-semibold">{queueMovies.length}</span>
            </span>
          </div>

          {voteError && (
            <div className="bg-danger/10 text-danger border border-danger/30 rounded-xl px-3 py-2 text-xs">
              {voteError}
            </div>
          )}

          {currentQueueMovie ? (
            <div className="relative max-w-4xl mx-auto">
              <SessionVoteCard
                key={currentQueueMovie.id}
                movie={{
                  ...currentQueueMovie.movie,
                  ...extractMovieMeta(currentQueueMovie.movie),
                }}
                sessionMovieId={currentQueueMovie.id}
                userHasSeen={Boolean(currentQueueMovie.movie.ratings?.[0]?.hasSeen)}
                rating={votes.get(currentQueueMovie.id)?.rating ?? null}
                willingToRewatch={
                  votes.get(currentQueueMovie.id)?.willingToRewatch ??
                  rewatchDrafts.get(currentQueueMovie.id) ??
                  false
                }
                onRate={(rating) => {
                  void handleQueueVote(currentQueueMovie.id, rating);
                }}
                onRewatchToggle={(willing) => {
                  void handleRewatchToggle(currentQueueMovie.id, willing);
                }}
                available={Boolean(
                  currentQueueMovie.movie.plexAvailability?.available ||
                    currentQueueMovie.movie.radarrSync?.available
                )}
              />

              {submittingVoteFor === currentQueueMovie.id && (
                <div className="absolute inset-0 bg-background/60 rounded-2xl flex items-center justify-center">
                  <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                </div>
              )}
            </div>
          ) : (
            <div className="bg-card border border-border rounded-xl p-6 text-center">
              <p className="text-sm text-muted">Fetching the next best movies for you...</p>
              <Button variant="secondary" className="mt-3" onClick={refreshQueue}>
                Refresh Queue
              </Button>
            </div>
          )}

          {queuePreview.length > 0 && (
            <div className="bg-card border border-border rounded-xl p-3">
              <p className="text-[11px] text-muted mb-2">Up next (ranked for you):</p>
              <div className="space-y-1">
                {queuePreview.map((movie, index) => (
                  <p key={movie.id} className="text-xs text-foreground/85 truncate">
                    {index + 1}. {movie.movie.title}
                    {movie.movie.year ? ` (${movie.movie.year})` : ""}
                  </p>
                ))}
              </div>
            </div>
          )}

          {canOpenLeaderboard ? (
            <Button size="lg" className="w-full" onClick={goToReview}>
              Open Leaderboard
            </Button>
          ) : (
            <p className="text-[11px] text-muted text-center">
              Leaderboard unlocks after enough signal is collected from everyone.
            </p>
          )}
        </div>
      )}

      {step === "reviewing" && (
        <div className="space-y-6 animate-slide-up">
          <div>
            <h3 className="text-lg font-semibold">Leaderboard</h3>
            <p className="text-xs text-muted">
              Edit your ratings here, then continue rating more movies or finalize the winner.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {sessionData.participants.map((participant) => (
              <div
                key={participant.userId}
                className="flex items-center gap-1.5 text-xs bg-card border border-border rounded-full px-2.5 py-1"
              >
                <span className="w-2 h-2 rounded-full bg-accent" />
                <span>{participant.user.name}</span>
              </div>
            ))}
          </div>

          <div className="space-y-3">
            {leaderboardRows.map((sessionMovie, rank) => {
              const available =
                sessionMovie.movie.plexAvailability?.available ||
                sessionMovie.movie.radarrSync?.available ||
                false;
              const userVote = activeUserId
                ? sessionMovie.votes.find((vote) => vote.userId === activeUserId)
                : undefined;
              const trackedVote = votes.get(sessionMovie.id);
              const effectiveRating = trackedVote?.rating ?? userVote?.rating ?? null;
              const effectiveWilling =
                trackedVote?.willingToRewatch ?? userVote?.willingToRewatch ?? false;
              const userHasSeen = Boolean(sessionMovie.movie.ratings?.[0]?.hasSeen);

              return (
                <div
                  key={sessionMovie.id}
                  className={`bg-card border rounded-xl p-4 ${
                    rank === 0 ? "border-accent ring-1 ring-accent/30" : "border-border"
                  }`}
                >
                  <div className="flex gap-4">
                    <div
                      className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-lg font-bold ${
                        rank === 0
                          ? "bg-accent text-white"
                          : "bg-card-hover text-muted"
                      }`}
                    >
                      {rank === 0 ? "🏆" : `#${rank + 1}`}
                    </div>

                    <div className="flex-shrink-0 w-16 h-24 rounded-lg overflow-hidden bg-card-hover">
                      {sessionMovie.movie.posterUrl ? (
                        <Image
                          src={sessionMovie.movie.posterUrl}
                          alt={sessionMovie.movie.title}
                          fill
                          sizes="64px"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-muted text-xs">
                          No poster
                        </div>
                      )}
                    </div>

                    <div className="flex-1 min-w-0 space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <h4 className="font-semibold text-sm truncate">
                            {sessionMovie.movie.title}
                            {sessionMovie.movie.year && (
                              <span className="text-muted font-normal ml-1">
                                ({sessionMovie.movie.year})
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
                              Score:{" "}
                              <span className="font-semibold text-accent">
                                {sessionMovie.score.toFixed(1)}
                              </span>
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="mt-2">
                        <p className="text-[11px] text-muted mb-1">Your rating</p>
                        <StarRating
                          size="sm"
                          rating={effectiveRating}
                          onChange={(rating) => {
                            const willing =
                              votes.get(sessionMovie.id)?.willingToRewatch ??
                              userVote?.willingToRewatch ??
                              false;
                            void (async () => {
                              if (submittingVoteFor === sessionMovie.id) return;
                              setVoteError(null);
                              applyVoteLocally(sessionMovie.id, rating, willing);
                              setSubmittingVoteFor(sessionMovie.id);
                              const success = await persistVote(sessionMovie.id, rating, willing);
                              await Promise.all([refreshSessionMovies(), refreshQueue()]);
                              if (!success) {
                                setVoteError("Could not save your rating update.");
                              }
                              setSubmittingVoteFor(null);
                            })();
                          }}
                        />
                        {userHasSeen && effectiveRating !== null && (
                          <button
                            onClick={() => {
                              void handleRewatchToggle(
                                sessionMovie.id,
                                !effectiveWilling
                              );
                            }}
                            className={`mt-2 text-[11px] px-2 py-1 rounded-lg transition-all ${
                              effectiveWilling
                                ? "bg-accent-soft text-accent border border-accent/30"
                                : "bg-card-hover text-muted border border-border"
                            }`}
                          >
                            {effectiveWilling
                              ? "Willing to rewatch"
                              : "Seen it. Tap if willing to rewatch"}
                          </button>
                        )}
                      </div>

                      <div className="mt-2 flex flex-wrap gap-2">
                        {sessionData.participants.map((participant) => {
                          const vote = sessionMovie.votes.find(
                            (existingVote) => existingVote.userId === participant.userId
                          );
                          return (
                            <div
                              key={participant.userId}
                              className="flex items-center gap-1 text-xs bg-card-hover rounded-full px-2 py-1"
                            >
                              <span className="text-muted">{participant.user.name}:</span>
                              {vote ? (
                                <span className="font-semibold">
                                  {"★".repeat(Math.round(vote.rating))}
                                  <span className="text-muted">
                                    {"★".repeat(5 - Math.round(vote.rating))}
                                  </span>
                                </span>
                              ) : (
                                <span className="text-muted italic">pending</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex gap-3">
            <Button variant="secondary" size="lg" className="flex-1" onClick={goBackToVoting}>
              Continue Rating
            </Button>
            <Button size="lg" className="flex-1" onClick={decideMovie} loading={deciding}>
              Finalize Decision
            </Button>
          </div>

          <p className="text-[11px] text-muted text-center">
            Winner score = 60% average rating + 40% minimum rating across voters.
          </p>
        </div>
      )}

      {step === "decided" && decidedMovie && (
        <div className="text-center space-y-6 py-8 animate-slide-up">
          <div className="w-20 h-20 mx-auto bg-success/15 rounded-full flex items-center justify-center">
            <svg
              className="w-10 h-10 text-success"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
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
            <div className="text-2xl font-bold text-accent">{decidedMovie.score.toFixed(1)}/5</div>
          </div>

          <Button variant="secondary" onClick={() => router.push("/dashboard")} className="mt-4">
            Back to Dashboard
          </Button>
        </div>
      )}
    </div>
  );
}
