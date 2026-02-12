import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const invite = await prisma.householdInvite.findUnique({
    where: { token },
    include: {
      household: {
        select: { id: true, name: true },
      },
    },
  });

  if (!invite) {
    return NextResponse.json({ valid: false }, { status: 404 });
  }

  const expired =
    Boolean(invite.expiresAt) && (invite.expiresAt as Date).getTime() < Date.now();
  const valid = invite.status === "pending" && !expired;

  return NextResponse.json({
    valid,
    token: invite.token,
    displayName: invite.displayName,
    email: invite.email,
    status: invite.status,
    expiresAt: invite.expiresAt,
    household: invite.household,
  });
}
