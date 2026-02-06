"use client";

import { useEffect, useState } from "react";
import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";

interface Household {
  id: string;
  name: string;
  inviteCode: string;
  role: string;
  members: { user: { id: string; name: string; avatarUrl: string | null } }[];
}

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

interface HouseholdInvite {
  id: string;
  token: string;
  status: string;
  displayName: string | null;
  email: string | null;
  createdAt: string;
  household: { id: string; name: string };
  invitePath: string;
}

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [households, setHouseholds] = useState<Household[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [newName, setNewName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [householdInvites, setHouseholdInvites] = useState<HouseholdInvite[]>([]);
  const [inviteHouseholdId, setInviteHouseholdId] = useState("");
  const [inviteDisplayName, setInviteDisplayName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [createdInviteLink, setCreatedInviteLink] = useState("");
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  useEffect(() => {
    if (status === "authenticated") {
      fetch("/api/household")
        .then((response) => response.json())
        .then((data) => {
          setHouseholds(data);
          const firstAdminHousehold = data.find(
            (household: Household) => household.role === "admin"
          );
          if (firstAdminHousehold) {
            setInviteHouseholdId(firstAdminHousehold.id);
          }
        });
      fetch("/api/sessions").then((response) => response.json()).then(setSessions);
      fetch("/api/household/invites")
        .then((response) => (response.ok ? response.json() : []))
        .then((data) => setHouseholdInvites(Array.isArray(data) ? data : []));
    }
  }, [status]);

  const refreshHouseholds = () =>
    fetch("/api/household").then((response) => response.json()).then(setHouseholds);

  const refreshInvites = () =>
    fetch("/api/household/invites")
      .then((response) => (response.ok ? response.json() : []))
      .then((data) => setHouseholdInvites(Array.isArray(data) ? data : []));

  const createHousehold = async () => {
    if (!newName.trim()) return;
    setLoading(true);
    const res = await fetch("/api/household", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    if (res.ok) {
      setShowCreate(false);
      setNewName("");
      await refreshHouseholds();
    }
    setLoading(false);
  };

  const joinHousehold = async () => {
    if (!inviteCode.trim()) return;
    setLoading(true);
    const res = await fetch("/api/household/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inviteCode }),
    });
    if (res.ok) {
      setShowJoin(false);
      setInviteCode("");
      await refreshHouseholds();
    }
    setLoading(false);
  };

  const createHouseholdInvite = async () => {
    if (!inviteHouseholdId) return;
    setCreatingInvite(true);
    setCreatedInviteLink("");

    const response = await fetch("/api/household/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        householdId: inviteHouseholdId,
        displayName: inviteDisplayName || undefined,
        email: inviteEmail || undefined,
      }),
    });

    if (response.ok) {
      const invite = await response.json();
      const absoluteLink = `${window.location.origin}${invite.invitePath}`;
      setCreatedInviteLink(absoluteLink);
      setInviteDisplayName("");
      setInviteEmail("");
      await refreshInvites();
    }

    setCreatingInvite(false);
  };

  const activeSessions = sessions.filter(
    (movieNightSession) =>
      movieNightSession.status === "gathering" ||
      movieNightSession.status === "voting"
  );
  const adminHouseholds = households.filter((household) => household.role === "admin");

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Hey, {session?.user?.name}</h1>
          <p className="text-sm text-muted">Ready for movie night?</p>
        </div>
        <button
          onClick={() => signOut({ callbackUrl: "/" })}
          className="text-xs text-muted hover:text-foreground transition-colors"
        >
          Sign out
        </button>
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-2 gap-3">
        <Link
          href="/preferences"
          className="bg-card border border-border rounded-2xl p-4 hover:border-accent/30 transition-all"
        >
          <div className="w-10 h-10 bg-accent-soft rounded-xl flex items-center justify-center mb-3">
            <svg className="w-5 h-5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>
          </div>
          <h3 className="text-sm font-semibold">Preferences</h3>
          <p className="text-[11px] text-muted mt-0.5">Rate movies & genres</p>
        </Link>
        <Link
          href="/session/new"
          className="bg-accent/10 border border-accent/20 rounded-2xl p-4 hover:bg-accent/15 transition-all"
        >
          <div className="w-10 h-10 bg-accent/20 rounded-xl flex items-center justify-center mb-3">
            <svg className="w-5 h-5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" />
            </svg>
          </div>
          <h3 className="text-sm font-semibold text-accent">Movie Night</h3>
          <p className="text-[11px] text-accent/70 mt-0.5">Start a session</p>
        </Link>
      </div>

      {activeSessions.length > 0 && (
        <div className="bg-card border border-accent/30 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Active Movie Nights</h2>
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

      {/* Households */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Your Households</h2>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setShowJoin(!showJoin)}>
              Join
            </Button>
            <Button size="sm" onClick={() => setShowCreate(!showCreate)}>
              Create
            </Button>
          </div>
        </div>

        {showCreate && (
          <div className="bg-card border border-border rounded-xl p-4 mb-3 space-y-3 animate-slide-up">
            <Input
              placeholder="Household name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={createHousehold} loading={loading}>
                Create
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {showJoin && (
          <div className="bg-card border border-border rounded-xl p-4 mb-3 space-y-3 animate-slide-up">
            <Input
              placeholder="Paste invite code"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={joinHousehold} loading={loading}>
                Join
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowJoin(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {households.length === 0 ? (
          <div className="bg-card border border-border rounded-xl p-8 text-center">
            <p className="text-sm text-muted">No households yet. Create or join one to get started!</p>
          </div>
        ) : (
          <div className="space-y-3">
            {households.map((h) => (
              <div key={h.id} className="bg-card border border-border rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold">{h.name}</h3>
                  <span className="text-[10px] bg-accent-soft text-accent px-2 py-0.5 rounded-full">
                    {h.role}
                  </span>
                </div>
                <div className="flex items-center gap-1 mb-3">
                  {h.members.map((m) => (
                    <div
                      key={m.user.id}
                      className="w-7 h-7 bg-accent/20 rounded-full flex items-center justify-center text-[10px] font-bold text-accent"
                      title={m.user.name}
                    >
                      {m.user.name.charAt(0).toUpperCase()}
                    </div>
                  ))}
                  <span className="text-xs text-muted ml-1">
                    {h.members.length} member{h.members.length !== 1 ? "s" : ""}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <code className="text-[11px] bg-background px-2 py-1 rounded-lg text-muted font-mono flex-1 truncate">
                    {h.inviteCode}
                  </code>
                  <button
                    onClick={() => navigator.clipboard.writeText(h.inviteCode)}
                    className="text-xs text-accent hover:underline"
                  >
                    Copy
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {adminHouseholds.length > 0 && (
        <div className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">Household Account Invites</h2>
            <p className="text-xs text-muted">
              Create an invite link for a household member to set up their login.
            </p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4 space-y-3">
            {adminHouseholds.length > 1 && (
              <div>
                <label className="text-xs text-muted mb-1 block">Household</label>
                <select
                  value={inviteHouseholdId}
                  onChange={(event) => setInviteHouseholdId(event.target.value)}
                  className="w-full bg-card-hover border border-border rounded-xl px-3 py-2 text-sm"
                >
                  {adminHouseholds.map((household) => (
                    <option key={household.id} value={household.id}>
                      {household.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <Input
              placeholder="Display name (optional)"
              value={inviteDisplayName}
              onChange={(event) => setInviteDisplayName(event.target.value)}
            />
            <Input
              placeholder="Email (optional)"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              type="email"
            />

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={createHouseholdInvite}
                loading={creatingInvite}
                disabled={!inviteHouseholdId}
              >
                Create Invite Link
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void refreshInvites()}>
                Refresh
              </Button>
            </div>

            {createdInviteLink && (
              <div className="bg-background/40 border border-border rounded-xl p-3">
                <p className="text-[11px] text-muted mb-1">Invite link</p>
                <div className="flex items-center gap-2">
                  <code className="text-[11px] text-foreground truncate flex-1">
                    {createdInviteLink}
                  </code>
                  <button
                    onClick={() => navigator.clipboard.writeText(createdInviteLink)}
                    className="text-xs text-accent hover:underline"
                  >
                    Copy
                  </button>
                </div>
              </div>
            )}

            {householdInvites.length > 0 && (
              <div className="space-y-2 pt-1">
                {householdInvites.slice(0, 8).map((invite) => (
                  <div
                    key={invite.id}
                    className="bg-background/30 border border-border rounded-xl px-3 py-2 flex items-center gap-2"
                  >
                    <div className="flex-1">
                      <div className="text-xs font-medium">
                        {invite.displayName || invite.email || "Household member"}
                      </div>
                      <p className="text-[11px] text-muted">
                        {invite.household.name} - {invite.status}
                      </p>
                    </div>
                    <button
                      onClick={() =>
                        navigator.clipboard.writeText(
                          `${window.location.origin}${invite.invitePath}`
                        )
                      }
                      className="text-xs text-accent hover:underline"
                    >
                      Copy Link
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Recent Sessions */}
      {sessions.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">Recent Sessions</h2>
          <div className="space-y-2">
            {sessions.slice(0, 5).map((s) => (
              <Link
                key={s.id}
                href={`/session/${s.id}`}
                className="block bg-card border border-border rounded-xl p-3 hover:border-accent/30 transition-all"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm font-medium">{s.household.name}</span>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-muted">
                        {new Date(s.createdAt).toLocaleDateString()}
                      </span>
                      <span className="text-xs text-muted">
                        {s.participants.length} people
                      </span>
                    </div>
                  </div>
                  <span
                    className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
                      s.status === "decided"
                        ? "bg-success/15 text-success"
                        : s.status === "voting"
                        ? "bg-warning/15 text-warning"
                        : "bg-accent-soft text-accent"
                    }`}
                  >
                    {s.status}
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
