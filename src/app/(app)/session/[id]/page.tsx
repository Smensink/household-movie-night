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
    user: { name: string };
  }[];
}

type Step = "preferences" | "voting" | "decided";

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

  const decideMovie = async () => {
    setDeciding(true);
    await submitVotes();

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
    const response = await fetch(`/api/sessions/${sessionId}`, {
      method: "DELETE",
    });
    setEndingSession(false);

    if (response.ok) {
      router.push("/dashboard");
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
        {(["preferences", "voting", "decided"] as Step[]).map((s, i) => (
          <div key={s} className="flex items-center gap-2 flex-1">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                step === s
                  ? "bg-accent text-white"
                  : i < ["preferences", "voting", "decided"].indexOf(step)
                  ? "bg-success text-white"
                  : "bg-card-hover text-muted"
              }`}
            >
              {i + 1}
            </div>
            <span className="text-[11px] text-muted capitalize hidden sm:block">
              {s}
            </span>
            {i < 2 && (
              <div className="flex-1 h-px bg-border" />
            )}
          </div>
        ))}
      </div>

      {/* Step: Preferences */}
      {step === "preferences" && (
        <div className="space-y-6 animate-slide-up">
          {/* Release year preference */}
          <div>
            <h3 className="text-sm font-semibold mb-2">Choose your release year range</h3>
            <div className="bg-card border border-border rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted">From</span>
                <span className="font-semibold text-foreground">{minReleaseYear}</span>
                <span className="text-muted">to</span>
                <span className="font-semibold text-foreground">{maxReleaseYear}</span>
              </div>
              <div className="space-y-2">
                <label className="text-[11px] text-muted">Minimum year</label>
                <input
                  type="range"
                  min={YEAR_MIN}
                  max={YEAR_MAX}
                  value={minReleaseYear}
                  onChange={(event) => {
                    const next = Number.parseInt(event.target.value, 10);
                    setMinReleaseYear(Math.min(next, maxReleaseYear));
                  }}
                  className="w-full h-2 bg-border rounded-lg appearance-none cursor-pointer accent-accent"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[11px] text-muted">Maximum year</label>
                <input
                  type="range"
                  min={YEAR_MIN}
                  max={YEAR_MAX}
                  value={maxReleaseYear}
                  onChange={(event) => {
                    const next = Number.parseInt(event.target.value, 10);
                    setMaxReleaseYear(Math.max(next, minReleaseYear));
                  }}
                  className="w-full h-2 bg-border rounded-lg appearance-none cursor-pointer accent-accent"
                />
              </div>
              <p className="text-[11px] text-muted">
                This works like a Tinder age range slider: picks are biased toward this release window.
              </p>
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
            onClick={decideMovie}
            loading={deciding}
            disabled={votes.size === 0}
          >
            Lock In Votes & Decide
          </Button>
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
