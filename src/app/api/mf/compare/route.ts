import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isInternalOrAdmin } from "@/lib/internal-auth";
import { evaluateHeuristicVsMF } from "@/lib/mf-heuristic-compare";
import { getModelMetadata } from "@/lib/matrix-factorization";

/**
 * POST /api/mf/compare
 * Compare heuristic vs MF on held-out historical user ratings (rating prediction error).
 *
 * Auth:
 * - household admin via session, OR
 * - internal caller via x-internal-key header
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
    const result = await evaluateHeuristicVsMF(body ?? {});
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
