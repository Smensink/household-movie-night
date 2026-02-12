import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { restoreSetupFromV3Request, BACKUP_V3_VERSION } from "@/lib/backup-v3";
import { runPostRestoreTraining } from "@/lib/post-restore-training";

export async function GET() {
  const userCount = await prisma.user.count();
  return NextResponse.json({
    canRestore: userCount === 0,
    userCount,
    supportedVersions: [BACKUP_V3_VERSION],
    expectedFormat: "v3-ndjson-gzip",
  });
}

export async function POST(req: NextRequest) {
  const userCount = await prisma.user.count();
  if (userCount > 0) {
    return NextResponse.json(
      {
        error:
          "Users already exist. Please log in as an admin to restore from backup via Settings.",
      },
      { status: 403 }
    );
  }

  try {
    const stats = await restoreSetupFromV3Request(req);
    const training = await runPostRestoreTraining();
    return NextResponse.json({
      message: "Backup restored successfully",
      format: "v3-ndjson-gzip",
      stats,
      training,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Restore failed";
    return NextResponse.json(
      {
        error: "Invalid backup file format",
        details: message,
      },
      { status: 400 }
    );
  }
}
