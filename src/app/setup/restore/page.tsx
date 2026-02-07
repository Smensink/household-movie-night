"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import Button from "@/components/ui/Button";

export default function SetupRestorePage() {
  const [backupFile, setBackupFile] = useState<File | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [canRestore, setCanRestore] = useState<boolean | null>(null);
  const [status, setStatus] = useState<{
    message: string;
    success: boolean;
    details?: string;
  } | null>(null);

  useEffect(() => {
    fetch("/api/setup/restore")
      .then((res) => res.json())
      .then((data) => setCanRestore(data.canRestore))
      .catch(() => setCanRestore(false));
  }, []);

  const handleRestore = async () => {
    if (!backupFile) return;
    setRestoring(true);
    setStatus(null);

    try {
      const text = await backupFile.text();
      const backup = JSON.parse(text);

      const res = await fetch("/api/setup/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(backup),
      });

      const data = await res.json();

      if (res.ok) {
        setStatus({
          message: "Backup restored successfully!",
          success: true,
          details: `Imported ${data.stats.users} users, ${data.stats.households} households, ${data.stats.movies} movies, ${data.stats.movieRatings} ratings.`,
        });
      } else {
        setStatus({
          message: data.error || "Restore failed",
          success: false,
        });
      }
    } catch {
      setStatus({
        message: "Invalid backup file format. Make sure it's a valid JSON backup file.",
        success: false,
      });
    }

    setRestoring(false);
  };

  if (canRestore === null) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!canRestore) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-md space-y-6">
          <div className="text-center">
            <h1 className="text-2xl font-bold">Restore from Backup</h1>
            <p className="text-sm text-muted mt-2">
              This instance already has users registered.
            </p>
          </div>

          <div className="bg-card border border-border rounded-xl p-6 space-y-4 text-center">
            <div className="w-12 h-12 mx-auto bg-warning/10 rounded-full flex items-center justify-center">
              <svg
                className="w-6 h-6 text-warning"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>
            <p className="text-sm">
              For security, public restore is only available on fresh installations
              with no existing users.
            </p>
            <p className="text-xs text-muted">
              To restore a backup, log in as an admin and use the Backup &amp; Restore
              section in Settings.
            </p>
          </div>

          <div className="text-center">
            <Link href="/login" className="text-sm text-accent hover:underline">
              Go to Login
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold">Restore from Backup</h1>
          <p className="text-sm text-muted mt-2">
            Import movie data from a previous Movie Night installation.
          </p>
        </div>

        <div className="bg-card border border-border rounded-xl p-6 space-y-4">
          <div>
            <p className="text-xs font-medium mb-2">Select Backup File</p>
            <label className="block">
              <input
                type="file"
                accept=".json"
                className="hidden"
                onChange={(e) => {
                  setBackupFile(e.target.files?.[0] || null);
                  setStatus(null);
                }}
              />
              <div className="bg-card-hover border border-border rounded-lg px-4 py-3 text-sm text-muted cursor-pointer hover:border-accent/30 transition-all text-center">
                {backupFile ? backupFile.name : "Choose backup JSON file..."}
              </div>
            </label>
          </div>

          <Button
            onClick={handleRestore}
            loading={restoring}
            disabled={!backupFile}
            className="w-full"
          >
            Restore Backup
          </Button>

          {status && (
            <div
              className={`p-3 rounded-lg text-sm ${
                status.success
                  ? "bg-success/10 border border-success/20 text-success"
                  : "bg-error/10 border border-error/20 text-error"
              }`}
            >
              <p className="font-medium">{status.message}</p>
              {status.details && (
                <p className="text-xs mt-1 opacity-80">{status.details}</p>
              )}
            </div>
          )}

          <div className="bg-card-hover border border-border rounded-lg p-3 space-y-2">
            <p className="text-xs font-medium">What gets restored:</p>
            <ul className="text-[11px] text-muted space-y-1 list-disc list-inside">
              <li>User accounts and households</li>
              <li>Movies, genres, studios, and people</li>
              <li>All ratings and preferences</li>
              <li>Integration configurations with API keys</li>
            </ul>
            <p className="text-[10px] text-muted mt-2">
              Users can log in with their existing credentials after restore.
            </p>
          </div>
        </div>

        <div className="text-center space-y-2">
          <Link href="/login" className="text-sm text-accent hover:underline">
            Continue to Login
          </Link>
          <p className="text-[11px] text-muted">
            You can also restore later from Settings after logging in.
          </p>
        </div>
      </div>
    </div>
  );
}
