"use client";

import { useEffect, useState, useCallback } from "react";
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
  participants: { userId: string; user: { name: string } }[];
}

type Step = "preferences" | "voting" | "decided";

export default function SessionPage() {
  const { data: session, status: authStatus } = useSession();
  const router = useRouter();
  const params = useParams();
  const sessionId = params.id as string;

  const [sessionData, setSessionData] = useState<SessionData | null>(null);
  const [genres, setGenres] = useState<Genre[]>([]);
  const [sessionMovies, setSessionMovies] = useState<SessionMovie[]>([]);
  const [step, setStep] = useState<Step>("preferences");
  const [eraPreference, setEraPreference] = useState<string | null>(null);
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

  useEffect(() => {
    if (authStatus === "unauthenticated") router.push("/login");
  }, [authStatus, router]);

  // Load session data
  useEffect(() => {
    if (authStatus !== "authenticated") return;

    Promise.all([
      fetch(`/api/sessions`)
        .then((r) => r.json())
        .then((sessions) => sessions.find((s: SessionData) => s.id === sessionId)),
      fetch("/api/genres").then((r) => r.json()),
      fetch(`/api/sessions/${sessionId}/movies`).then((r) => r.json()),
      fetch("/api/settings").then((r) => r.json()),
    ]).then(([sess, genreData, movies, settingsData]) => {
      if (settingsData?.explorationFactor !== undefined) {
        setExplorationFactor(settingsData.explorationFactor);
      }
      setSessionData(sess || null);
      setGenres(genreData.genres || []);
      setSessionMovies(Array.isArray(movies) ? movies : []);

      if (sess?.status === "decided") {
        setStep("decided");
      } else if (sess?.status === "voting" || (Array.isArray(movies) && movies.length > 0)) {
        setStep("voting");
      }
      setLoading(false);
    });
  }, [authStatus, sessionId]);

  const savePreferences = async (
    genreRankings: { genreId: string; rank: number }[]
  ) => {
    await fetch(`/api/sessions/${sessionId}/preferences`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eraPreference, genreRankings }),
    });
  };

  const generateMovies = async () => {
    setGenerating(true);
    // Save current exploration factor before generating
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ explorationFactor }),
    });
    const res = await fetch(`/api/sessions/${sessionId}/movies`, {
      method: "POST",
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

    await fetch(`/api/sessions/${sessionId}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ votes: voteArray }),
    });
  };

  const decideMovie = async () => {
    setDeciding(true);
    await submitVotes();

    const res = await fetch(`/api/sessions/${sessionId}/decide`, {
      method: "POST",
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
        </div>
        <button
          onClick={copyGuestLink}
          className="text-xs text-accent hover:underline"
        >
          {copied ? "Copied!" : "Invite Guest"}
        </button>
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
          {/* Era preference */}
          <div>
            <h3 className="text-sm font-semibold mb-2">What era are you feeling?</h3>
            <div className="grid grid-cols-2 gap-2">
              {[
                { value: null, label: "Any era" },
                { value: "new_release", label: "New Release" },
                { value: "modern_classic", label: "Modern Classic (2000+)" },
                { value: "classic", label: "Classic (pre-2000)" },
              ].map((era) => (
                <button
                  key={era.label}
                  onClick={() => setEraPreference(era.value)}
                  className={`text-sm p-3 rounded-xl border transition-all ${
                    eraPreference === era.value
                      ? "border-accent bg-accent/5 text-accent font-medium"
                      : "border-border bg-card text-muted hover:border-accent/30"
                  }`}
                >
                  {era.label}
                </button>
              ))}
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

          {sessionMovies.map((sm) => {
            const vote = votes.get(sm.id);
            const available =
              sm.movie.plexAvailability?.available ||
              sm.movie.radarrSync?.available ||
              false;

            return (
              <SessionVoteCard
                key={sm.id}
                movie={sm.movie}
                sessionMovieId={sm.id}
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
