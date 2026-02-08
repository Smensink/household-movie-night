import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createBackupV3Stream, type BackupProgressState } from "@/lib/backup-v3";

let backupProgress: BackupProgressState = {
  inProgress: false,
  phase: "",
  current: 0,
  total: 0,
  startedAt: null,
};

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (req.nextUrl.searchParams.get("status") === "true") {
    return NextResponse.json({
      ...backupProgress,
      startedAt: backupProgress.startedAt?.toISOString() || null,
      format: "v3-ndjson-gzip",
    });
  }

  if (backupProgress.inProgress) {
    return NextResponse.json(
      { error: "Backup already in progress", progress: backupProgress },
      { status: 409 }
    );
  }

  const includeEmbeddedAssets =
    req.nextUrl.searchParams.get("includeEmbeddedAssets") === "true";

  backupProgress = {
    inProgress: true,
    phase: "Starting backup...",
    current: 0,
    total: 0,
    startedAt: new Date(),
  };

  const stream = createBackupV3Stream(
    { includeEmbeddedAssets },
    backupProgress
  );

  const date = new Date().toISOString().split("T")[0];
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "application/gzip",
      "X-Backup-Format": "v3-gzip",
      "Content-Disposition": `attachment; filename="movie-night-backup-${date}.v3.ndjson.gz"`,
    },
  });
}
