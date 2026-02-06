"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { useParams, useRouter } from "next/navigation";
import Input from "@/components/ui/Input";
import Button from "@/components/ui/Button";

interface InviteData {
  valid: boolean;
  household?: { id: string; name: string };
  displayName?: string | null;
  email?: string | null;
  status?: string;
}

export default function HouseholdInvitePage() {
  const router = useRouter();
  const params = useParams();
  const token = params.token as string;

  const [loadingInvite, setLoadingInvite] = useState(true);
  const [invite, setInvite] = useState<InviteData | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`/api/household/invites/${token}`)
      .then((response) => response.json())
      .then((data: InviteData) => {
        setInvite(data);
        if (data?.displayName) setName(data.displayName);
        if (data?.email) setEmail(data.email);
      })
      .catch(() => setInvite({ valid: false }))
      .finally(() => setLoadingInvite(false));
  }, [token]);

  const acceptInvite = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);

    const response = await fetch("/api/household/invites/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        name,
        email,
        password,
      }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setError(data.error || "Failed to accept invite");
      setSubmitting(false);
      return;
    }

    const loginResult = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    setSubmitting(false);
    if (loginResult?.error) {
      setError("Account created. Please sign in manually.");
      router.push("/login");
      return;
    }

    router.push("/dashboard");
  };

  if (loadingInvite) {
    return (
      <div className="min-h-dvh flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!invite?.valid) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center px-6 py-12">
        <div className="w-full max-w-md bg-card border border-border rounded-2xl p-6 text-center">
          <h1 className="text-xl font-semibold">Invite not available</h1>
          <p className="text-sm text-muted mt-2">
            This invite link is invalid, expired, or already used.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold">Join Household</h1>
          <p className="text-sm text-muted mt-1">
            Create your account for <span className="text-foreground">{invite.household?.name}</span>
          </p>
        </div>

        <form onSubmit={acceptInvite} className="space-y-4 bg-card border border-border rounded-2xl p-5">
          <Input
            label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Your name"
            required
          />
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            required
          />
          <Input
            label="Password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="At least 6 characters"
            minLength={6}
            required
          />

          {error && (
            <div className="bg-danger/10 border border-danger/20 text-danger text-sm px-4 py-2 rounded-xl">
              {error}
            </div>
          )}

          <Button type="submit" className="w-full" loading={submitting} size="lg">
            Accept Invite & Create Account
          </Button>
        </form>
      </div>
    </div>
  );
}
