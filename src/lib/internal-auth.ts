import { auth } from "@/lib/auth";
import { isUserHouseholdAdmin } from "@/lib/household-admin";

/**
 * Check if request is from an internal Docker startup script (via INTERNAL_API_KEY header)
 * or from an authenticated household admin. Used to protect maintenance endpoints
 * that are called both by the Docker CMD script and by admin users.
 */
export async function isInternalOrAdmin(request: Request): Promise<boolean> {
  const internalKey = process.env.INTERNAL_API_KEY;
  if (internalKey) {
    const provided = request.headers.get("x-internal-key");
    if (provided === internalKey) return true;
  }

  const session = await auth();
  if (session?.user?.id) {
    const isAdmin = await isUserHouseholdAdmin(session.user.id);
    if (isAdmin) return true;
  }

  return false;
}
