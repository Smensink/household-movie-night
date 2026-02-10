import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isInternalOrAdmin } from "@/lib/internal-auth";
import { evaluateMatrixFactorizationModel } from "@/lib/mf-eval";
import { getModelMetadata } from "@/lib/matrix-factorization";

/**
 * POST /api/mf/eval
 * Evaluate the saved model with ranking metrics (NDCG/MAP/AUC/HitRate) on a deterministic holdout split.
 *
 * Auth:
 * - household admin via session, OR
 * - internal caller via x-internal-key header
 *
 * Note: This does NOT train or mutate the model.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  const isInternal = await isInternalOrAdmin(req);
  if (!session?.user?.id && !isInternal) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const model = await getModelMetadata();
  if (!model) {
    return NextResponse.json({ error: "No model metadata found (model not trained yet)" }, { status: 400 });
  }
  if (model.isTraining) {
    return NextResponse.json({ error: "Model is currently training; try again later" }, { status: 409 });
  }

  const body = await req.json().catch(() => ({}));

  try {
    const result = await evaluateMatrixFactorizationModel(body ?? {});
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

