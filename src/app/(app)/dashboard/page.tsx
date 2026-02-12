"use client";

import { useEffect, useState } from "react";
import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

const LAST_RATE_PATH_KEY = "lastRatePath";
const ACTIVE_HOUSEHOLD_KEY = "activeHouseholdId";

const RATE_DESTINATIONS: Record<string, { title: string; subtitle: string }> = {
  "/preferences/movies": { title: "Movies", subtitle: "Movie queue" },
  "/preferences/people": { title: "People", subtitle: "Actors and directors" },
  "/preferences/studios": { title: "Studios", subtitle: "Production companies" },
  "/preferences/upcoming": { title: "Upcoming", subtitle: "Future releases" },
  "/preferences/radarr-threshold": {
    title: "Near Threshold",
    subtitle: "Radarr consensus queue",
  },
  "/preferences/search": { title: "Search & Rate", subtitle: "Find specific titles" },
  "/preferences/genres": { title: "Genres", subtitle: "Rank genre preferences" },
};

interface Household {
  id: string;
  name: string;
  role: string;
  members: { user: { id: string; name: string } }[];
}

interface Session {
  id: string;
  status: string;
  createdAt: string;
  guestInviteCode: string;
  canManage: boolean;
  isParticipant: boolean;
  household: { id: string; name: string };
  participants: { user: { name: string } }[];
}

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [households, setHouseholds] = useState<Household[]>([]);
  const [movieRatingCount, setMovieRatingCount] = useState(0);
  const [rankedGenresCount, setRankedGenresCount] = useState(0);
  const [lastRatePath, setLastRatePath] = useState(() => {
    if (typeof window === "undefined") return "/preferences/movies";
    const storedRatePath = localStorage.getItem(LAST_RATE_PATH_KEY);
    if (storedRatePath && RATE_DESTINATIONS[storedRatePath]) {
      return storedRatePath;
    }
    return "/preferences/movies";
  });
  const [selectedHouseholdId, setSelectedHouseholdId] = useState<string>("");

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  useEffect(() => {
    if (status !== "authenticated") return;

    Promise.all([
      fetch("/api/sessions")
        .then((response) => (response.ok ? response.json() : []))
        .catch(() => []),
      fetch("/api/household")
        .then((response) => (response.ok ? response.json() : []))
        .catch(() => []),
      fetch("/api/ratings")
        .then((response) => (response.ok ? response.json() : []))
        .catch(() => []),
      fetch("/api/genres")
        .then((response) => (response.ok ? response.json() : { rankings: {} }))
        .catch(() => ({ rankings: {} })),
    ]).then(([sessionsData, householdsData, ratingsData, genresData]) => {
      const safeSessions = Array.isArray(sessionsData) ? (sessionsData as Session[]) : [];
      const safeHouseholds = Array.isArray(householdsData)
        ? (householdsData as Household[])
        : [];

      setSessions(safeSessions);
      setHouseholds(safeHouseholds);
      setMovieRatingCount(Array.isArray(ratingsData) ? ratingsData.length : 0);
      setRankedGenresCount(Object.keys(genresData?.rankings || {}).length);

      const storedHouseholdId =
        typeof window !== "undefined"
          ? localStorage.getItem(ACTIVE_HOUSEHOLD_KEY)
          : null;
      const defaultHouseholdId = safeHouseholds[0]?.id ?? "";
      const nextSelectedHouseholdId =
        storedHouseholdId && safeHouseholds.some((household) => household.id === storedHouseholdId)
          ? storedHouseholdId
          : defaultHouseholdId;
      setSelectedHouseholdId(nextSelectedHouseholdId);
    });
  }, [status]);

  const persistLastRatePath = (path: string) => {
    setLastRatePath(path);
    if (typeof window !== "undefined") {
      localStorage.setItem(LAST_RATE_PATH_KEY, path);
    }
  };

  const updateSelectedHousehold = (householdId: string) => {
    setSelectedHouseholdId(householdId);
    if (typeof window !== "undefined") {
      localStorage.setItem(ACTIVE_HOUSEHOLD_KEY, householdId);
    }
  };

  const continueRatingDestination = RATE_DESTINATIONS[lastRatePath] || RATE_DESTINATIONS["/preferences/movies"];

  const scopedSessions = selectedHouseholdId
    ? sessions.filter((movieNightSession) => movieNightSession.household.id === selectedHouseholdId)
    : sessions;

  const activeSessions = scopedSessions.filter(
    (movieNightSession) =>
      movieNightSession.status === "gathering" ||
      movieNightSession.status === "voting"
  );
  const recentSessions = scopedSessions
    .filter((movieNightSession) => movieNightSession.status !== "gathering" && movieNightSession.status !== "voting")
    .slice(0, 5);

  const checklistSteps = [
    {
      id: "household",
      label: "Join or create a household",
      complete: households.length > 0,
      href: "/settings",
      cta: "Open household settings",
    },
    {
      id: "genres",
      label: "Rank your genres",
      complete: rankedGenresCount > 0,
      href: "/preferences/genres",
      cta: "Rank genres",
    },
    {
      id: "movies",
      label: `Rate at least 10 movies (${Math.min(movieRatingCount, 10)}/10)`,
      complete: movieRatingCount >= 10,
      href: "/preferences/movies",
      cta: "Rate movies",
    },
    {
      id: "session",
      label: "Start your first movie night",
      complete: sessions.length > 0,
      href: "/session/new",
      cta: "Start movie night",
    },
  ];

  const completedChecklistSteps = checklistSteps.filter((step) => step.complete).length;
  const nextChecklistStep = checklistSteps.find((step) => !step.complete);

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Hey, {session?.user?.name}</h1>
          <p className="text-sm text-muted">Pick up where you left off.</p>
        </div>
        <button
          onClick={() => signOut({ callbackUrl: "/" })}
          className="text-xs text-muted hover:text-foreground transition-colors"
        >
          Sign out
        </button>
      </div>

      {completedChecklistSteps < checklistSteps.length && (
        <div className="bg-card border border-accent/30 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">First-Time Setup</h2>
              <p className="text-[11px] text-muted">
                Complete these steps once for better recommendations.
              </p>
            </div>
            <span className="text-[10px] bg-accent-soft text-accent px-2 py-0.5 rounded-full">
              {completedChecklistSteps}/{checklistSteps.length}
            </span>
          </div>
          <div className="w-full h-1.5 bg-border rounded-full overflow-hidden">
            <div
              className="h-full bg-accent transition-all duration-300"
              style={{
                width: `${(completedChecklistSteps / checklistSteps.length) * 100}%`,
              }}
            />
          </div>
          <div className="space-y-1.5">
            {checklistSteps.map((step) => (
              <div key={step.id} className="flex items-center gap-2 text-xs">
                <span
                  className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                    step.complete
                      ? "border-success bg-success/10 text-success"
                      : "border-border text-muted"
                  }`}
                >
                  {step.complete ? "✓" : ""}
                </span>
                <span className={step.complete ? "text-foreground" : "text-muted"}>
                  {step.label}
                </span>
              </div>
            ))}
          </div>
          {nextChecklistStep && (
            <Link
              href={nextChecklistStep.href}
              className="inline-flex items-center rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white hover:bg-accent/90 transition-all"
            >
              {nextChecklistStep.cta}
            </Link>
          )}
        </div>
      )}

      {households.length > 0 && (
        <div className="bg-card border border-border rounded-2xl p-4 space-y-2">
          <h2 className="text-sm font-semibold">Household Context</h2>
          {households.length > 1 ? (
            <select
              value={selectedHouseholdId}
              onChange={(event) => updateSelectedHousehold(event.target.value)}
              className="w-full bg-card-hover border border-border rounded-xl px-3 py-2 text-sm"
            >
              {households.map((household) => (
                <option key={household.id} value={household.id}>
                  {household.name}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-xs text-muted">{households[0]?.name}</p>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Link
          href={lastRatePath}
          onClick={() => persistLastRatePath(lastRatePath)}
          className="bg-card border border-border rounded-2xl p-4 hover:border-accent/30 transition-all"
        >
          <h3 className="text-sm font-semibold">Resume {continueRatingDestination.title}</h3>
          <p className="text-[11px] text-muted mt-1">{continueRatingDestination.subtitle}</p>
        </Link>

        <Link
          href="/session/new"
          className="bg-accent/10 border border-accent/20 rounded-2xl p-4 hover:bg-accent/15 transition-all"
        >
          <h3 className="text-sm font-semibold text-accent">Start Movie Night</h3>
          <p className="text-[11px] text-accent/70 mt-1">Create a session</p>
        </Link>

        <Link
          href="/preferences/radarr-threshold"
          onClick={() => persistLastRatePath("/preferences/radarr-threshold")}
          className="bg-card border border-border rounded-2xl p-4 hover:border-accent/30 transition-all"
        >
          <h3 className="text-sm font-semibold">Near Threshold</h3>
          <p className="text-[11px] text-muted mt-1">Boost Radarr consensus</p>
        </Link>

        <Link
          href="/preferences/upcoming"
          onClick={() => persistLastRatePath("/preferences/upcoming")}
          className="bg-card border border-border rounded-2xl p-4 hover:border-accent/30 transition-all"
        >
          <h3 className="text-sm font-semibold">Upcoming</h3>
          <p className="text-[11px] text-muted mt-1">Vote on future releases</p>
        </Link>

        <Link
          href="/preferences/search"
          onClick={() => persistLastRatePath("/preferences/search")}
          className="bg-card border border-border rounded-2xl p-4 hover:border-accent/30 transition-all"
        >
          <h3 className="text-sm font-semibold">Search & Rate</h3>
          <p className="text-[11px] text-muted mt-1">Find specific titles</p>
        </Link>

        <Link
          href="/profile"
          className="bg-card border border-border rounded-2xl p-4 hover:border-accent/30 transition-all"
        >
          <h3 className="text-sm font-semibold">Profile</h3>
          <p className="text-[11px] text-muted mt-1">Taste and archetypes</p>
        </Link>
      </div>

      {activeSessions.length > 0 && (
        <div className="bg-card border border-accent/30 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Resume Active Movie Nights</h2>
            <span className="text-[10px] bg-accent-soft text-accent px-2 py-0.5 rounded-full">
              {activeSessions.length} live
            </span>
          </div>
          <div className="space-y-2">
            {activeSessions.map((movieNightSession) => (
              <Link
                key={movieNightSession.id}
                href={`/session/${movieNightSession.id}`}
                className="block bg-background/40 border border-border rounded-xl p-3 hover:border-accent/30 transition-all"
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">{movieNightSession.household.name}</div>
                    <p className="text-[11px] text-muted mt-0.5">
                      Session token:{" "}
                      <code className="text-foreground">{movieNightSession.guestInviteCode}</code>
                    </p>
                  </div>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-warning/15 text-warning">
                    {movieNightSession.status}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {selectedHouseholdId && activeSessions.length === 0 && scopedSessions.length === 0 && (
        <div className="bg-card border border-border rounded-xl p-4 text-xs text-muted">
          No sessions yet for this household.
        </div>
      )}

      {recentSessions.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">Recent Sessions</h2>
          <div className="space-y-2">
            {recentSessions.map((movieNightSession) => (
              <Link
                key={movieNightSession.id}
                href={`/session/${movieNightSession.id}`}
                className="block bg-card border border-border rounded-xl p-3 hover:border-accent/30 transition-all"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm font-medium">{movieNightSession.household.name}</span>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-muted">
                        {new Date(movieNightSession.createdAt).toLocaleDateString()}
                      </span>
                      <span className="text-xs text-muted">
                        {movieNightSession.participants.length} people
                      </span>
                    </div>
                  </div>
                  <span
                    className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
                      movieNightSession.status === "decided"
                        ? "bg-success/15 text-success"
                        : "bg-card-hover text-muted"
                    }`}
                  >
                    {movieNightSession.status}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
