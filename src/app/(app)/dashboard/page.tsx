"use client";

import { useEffect, useState } from "react";
import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface Session {
  id: string;
  status: string;
  createdAt: string;
  guestInviteCode: string;
  canManage: boolean;
  isParticipant: boolean;
  household: { name: string };
  participants: { user: { name: string } }[];
}

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [sessions, setSessions] = useState<Session[]>([]);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  useEffect(() => {
    if (status !== "authenticated") return;
    fetch("/api/sessions")
      .then((response) => (response.ok ? response.json() : []))
      .then((data) => setSessions(Array.isArray(data) ? data : []))
      .catch(() => setSessions([]));
  }, [status]);

  const activeSessions = sessions.filter(
    (movieNightSession) =>
      movieNightSession.status === "gathering" ||
      movieNightSession.status === "voting"
  );
  const recentSessions = sessions
    .filter((movieNightSession) => movieNightSession.status !== "gathering" && movieNightSession.status !== "voting")
    .slice(0, 5);

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

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Link
          href="/preferences/movies"
          className="bg-card border border-border rounded-2xl p-4 hover:border-accent/30 transition-all"
        >
          <h3 className="text-sm font-semibold">Continue Rating</h3>
          <p className="text-[11px] text-muted mt-1">Movie queue</p>
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
          className="bg-card border border-border rounded-2xl p-4 hover:border-accent/30 transition-all"
        >
          <h3 className="text-sm font-semibold">Near Threshold</h3>
          <p className="text-[11px] text-muted mt-1">Boost Radarr consensus</p>
        </Link>

        <Link
          href="/preferences/upcoming"
          className="bg-card border border-border rounded-2xl p-4 hover:border-accent/30 transition-all"
        >
          <h3 className="text-sm font-semibold">Upcoming</h3>
          <p className="text-[11px] text-muted mt-1">Vote on future releases</p>
        </Link>

        <Link
          href="/preferences/search"
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
