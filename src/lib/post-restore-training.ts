import { shouldRetrain, trainMatrixFactorization } from "@/lib/matrix-factorization";

export type PostRestoreTrainingResult = {
  attempted: boolean;
  trained: boolean;
  message: string;
  details?: {
    ratingsProcessed?: number;
    epochs?: number;
    rmse?: number;
    validationRmse?: number;
    featuresLearned?: number;
  };
};

export async function runPostRestoreTraining(): Promise<PostRestoreTrainingResult> {
  const needsRetrain = await shouldRetrain();
  if (!needsRetrain) {
    return {
      attempted: false,
      trained: false,
      message:
        "Model training skipped: not enough ratings yet or no new ratings since last training.",
    };
  }

  try {
    const result = await trainMatrixFactorization();
    return {
      attempted: true,
      trained: true,
      message: "Model training completed after restore.",
      details: {
        ratingsProcessed: result.ratingsProcessed,
        epochs: result.epochs,
        rmse: result.rmse,
        validationRmse: result.validationRmse,
        featuresLearned: result.featuresLearned,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown training error";
    return {
      attempted: true,
      trained: false,
      message: `Model training failed after restore: ${message}`,
    };
  }
}
