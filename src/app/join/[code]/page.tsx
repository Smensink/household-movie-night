"use client";

import { useState } from "react";
import { useRouter, useParams } from "next/navigation";
import Input from "@/components/ui/Input";
import Button from "@/components/ui/Button";

export default function JoinSessionPage() {
  const router = useRouter();
  const params = useParams();
  const code = params.code as string;
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    setError("");

    const res = await fetch(`/api/sessions/join/${code}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });

    if (!res.ok) {
      const data = await res.json();
      setError(data.error || "Failed to join session");
      setLoading(false);
      return;
    }

    const data = await res.json();
    // Store guest token in session storage
    sessionStorage.setItem("guestToken", data.guestToken);
    sessionStorage.setItem("guestSessionId", data.sessionId);
    sessionStorage.setItem("guestUserId", data.userId);
    router.push(`/session/${data.sessionId}`);
  };

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center">
          <div className="w-16 h-16 mx-auto bg-accent-soft rounded-2xl flex items-center justify-center mb-4">
            <svg className="w-8 h-8 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold">Join Movie Night</h1>
          <p className="text-sm text-muted mt-1">
            You&apos;ve been invited to pick a movie!
          </p>
        </div>

        <form onSubmit={handleJoin} className="space-y-4">
          <Input
            label="Your Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Enter your name"
            required
          />

          {error && (
            <div className="bg-danger/10 border border-danger/20 text-danger text-sm px-4 py-2 rounded-xl">
              {error}
            </div>
          )}

          <Button type="submit" loading={loading} className="w-full" size="lg">
            Join Session
          </Button>
        </form>
      </div>
    </div>
  );
}
