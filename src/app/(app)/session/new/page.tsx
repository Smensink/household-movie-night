"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";

interface Household {
  id: string;
  name: string;
  members: { user: { id: string; name: string } }[];
}

export default function NewSessionPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [households, setHouseholds] = useState<Household[]>([]);
  const [selectedHousehold, setSelectedHousehold] = useState<string>("");
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(
    new Set()
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  useEffect(() => {
    if (status === "authenticated") {
      fetch("/api/household")
        .then((r) => r.json())
        .then((data) => {
          setHouseholds(data);
          if (data.length > 0) {
            setSelectedHousehold(data[0].id);
            // Auto-select current user
            setSelectedMembers(new Set([session?.user?.id || ""]));
          }
        });
    }
  }, [status, session]);

  const currentHousehold = households.find(
    (h) => h.id === selectedHousehold
  );

  const toggleMember = (userId: string) => {
    setSelectedMembers((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  };

  const startSession = async () => {
    if (!selectedHousehold || selectedMembers.size === 0) return;
    setLoading(true);

    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        householdId: selectedHousehold,
        participantIds: Array.from(selectedMembers),
      }),
    });

    if (res.ok) {
      const data = await res.json();
      router.push(`/session/${data.id}`);
    }
    setLoading(false);
  };

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="text-center">
        <div className="w-16 h-16 mx-auto bg-accent-soft rounded-2xl flex items-center justify-center mb-4">
          <svg className="w-8 h-8 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold">Movie Night!</h1>
        <p className="text-sm text-muted mt-1">
          Choose who&apos;s watching tonight
        </p>
      </div>

      {households.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-8 text-center">
          <p className="text-sm text-muted">
            You need to create or join a household first.
          </p>
          <Button
            className="mt-4"
            onClick={() => router.push("/dashboard")}
          >
            Go to Dashboard
          </Button>
        </div>
      ) : (
        <>
          {/* Household selection */}
          {households.length > 1 && (
            <div>
              <label className="text-sm font-medium mb-2 block">
                Select Household
              </label>
              <div className="space-y-2">
                {households.map((h) => (
                  <button
                    key={h.id}
                    onClick={() => {
                      setSelectedHousehold(h.id);
                      setSelectedMembers(
                        new Set([session?.user?.id || ""])
                      );
                    }}
                    className={`w-full text-left bg-card border rounded-xl p-3 transition-all ${
                      selectedHousehold === h.id
                        ? "border-accent bg-accent/5"
                        : "border-border hover:border-accent/30"
                    }`}
                  >
                    <span className="text-sm font-medium">{h.name}</span>
                    <span className="text-xs text-muted ml-2">
                      {h.members.length} members
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Member selection */}
          {currentHousehold && (
            <div>
              <label className="text-sm font-medium mb-2 block">
                Who&apos;s watching tonight?
              </label>
              <div className="space-y-2">
                {currentHousehold.members.map((m) => (
                  <button
                    key={m.user.id}
                    onClick={() => toggleMember(m.user.id)}
                    className={`w-full flex items-center gap-3 bg-card border rounded-xl p-3 transition-all ${
                      selectedMembers.has(m.user.id)
                        ? "border-accent bg-accent/5"
                        : "border-border hover:border-accent/30"
                    }`}
                  >
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                        selectedMembers.has(m.user.id)
                          ? "bg-accent text-white"
                          : "bg-card-hover text-muted"
                      }`}
                    >
                      {m.user.name.charAt(0).toUpperCase()}
                    </div>
                    <span className="text-sm font-medium">{m.user.name}</span>
                    {m.user.id === session?.user?.id && (
                      <span className="text-[10px] text-muted">(you)</span>
                    )}
                    <div className="ml-auto">
                      {selectedMembers.has(m.user.id) && (
                        <svg className="w-5 h-5 text-accent" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                        </svg>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Start button */}
          <Button
            size="lg"
            className="w-full"
            onClick={startSession}
            loading={loading}
            disabled={selectedMembers.size === 0}
          >
            Start Movie Night ({selectedMembers.size} viewer
            {selectedMembers.size !== 1 ? "s" : ""})
          </Button>
        </>
      )}
    </div>
  );
}
