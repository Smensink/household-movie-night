import { NextResponse } from "next/server";
import { importRadarrLibrary, syncRadarrAvailability } from "@/lib/api/radarr";

/**
 * POST /api/radarr/import
 * Import all movies from Radarr library into our database.
 * This ensures all Radarr movies are available in the rating queue.
 * Called on startup and can be triggered manually.
 */
export async function POST() {
  console.log("[Radarr Import] Starting Radarr library import via API...");

  try {
    const result = await importRadarrLibrary();

    return NextResponse.json({
      message: `Imported ${result.imported} movies from Radarr library`,
      ...result,
    });
  } catch (error) {
    console.error("[Radarr Import] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Import failed" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/radarr/import
 * Check status of Radarr integration and movie counts.
 */
export async function GET() {
  try {
    // Quick availability sync to get current counts
    const syncResult = await syncRadarrAvailability();

    return NextResponse.json({
      radarrMovieCount: syncResult.total,
      linkedMovies: syncResult.updated + syncResult.added,
      status: syncResult.total > 0 ? "connected" : "not_configured",
    });
  } catch (error) {
    return NextResponse.json({
      radarrMovieCount: 0,
      linkedMovies: 0,
      status: "error",
      error: error instanceof Error ? error.message : "Failed to check status",
    });
  }
}
