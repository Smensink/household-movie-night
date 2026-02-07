import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  trainMatrixFactorization,
  getModelMetadata,
  shouldRetrain,
  isSystemInactive,
} from "@/lib/matrix-factorization";

const INACTIVITY_THRESHOLD_MINUTES = 10;

/**
 * GET /api/mf/train
 * Get training status and model metadata
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const metadata = await getModelMetadata();
  const needsRetrain = await shouldRetrain();
  const inactive = await isSystemInactive(INACTIVITY_THRESHOLD_MINUTES);

  return NextResponse.json({
    model: metadata,
    needsRetrain,
    isInactive: inactive,
    inactivityThreshold: INACTIVITY_THRESHOLD_MINUTES,
  });
}

/**
 * POST /api/mf/train
 * Trigger model training (manual or automatic)
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const force = body.force === true;

  // Check if we should train
  const needsRetrain = await shouldRetrain();
  if (!force && !needsRetrain) {
    return NextResponse.json({
      message: "Training not needed",
      reason: "No new ratings since last training",
    });
  }

  try {
    const result = await trainMatrixFactorization({
      epochs: body.epochs ?? 20,
      learningRate: body.learningRate,
      regularization: body.regularization,
    });

    return NextResponse.json({
      message: "Training completed successfully",
      result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * PATCH /api/mf/train
 * Auto-retrain if inactive for 10 minutes and retraining is needed
 * This is called periodically by a background job
 */
export async function PATCH() {
  // Check inactivity
  const inactive = await isSystemInactive(INACTIVITY_THRESHOLD_MINUTES);
  if (!inactive) {
    console.log("[MF Train] System is active, skipping retrain");
    return NextResponse.json({
      message: "System is active, skipping retrain",
      inactive: false,
    });
  }

  // Check if retrain is needed
  const needsRetrain = await shouldRetrain();
  if (!needsRetrain) {
    console.log("[MF Train] No retrain needed (not enough ratings or no new data)");
    return NextResponse.json({
      message: "No retrain needed",
      inactive: true,
      needsRetrain: false,
    });
  }

  try {
    console.log("[MF Train] Starting model training...");
    const result = await trainMatrixFactorization();
    console.log(`[MF Train] Training complete: ${result.ratingsProcessed} ratings, ${result.featuresLearned} features, RMSE=${result.rmse.toFixed(4)}`);

    return NextResponse.json({
      message: "Auto-retrain completed",
      inactive: true,
      result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[MF Train] Training failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
