import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isUserAdminForHousehold } from "@/lib/household-admin";

const DEFAULT_EXPIRY_DAYS = 14;
const MAX_EXPIRY_DAYS = 90;

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length > 0 ? email : null;
}

export async function GET(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const adminMemberships = await prisma.householdMember.findMany({
    where: { userId, role: "admin" },
    select: { householdId: true },
  });
  const adminHouseholdIds = adminMemberships.map((membership) => membership.householdId);
  if (adminHouseholdIds.length === 0) {
    return NextResponse.json([]);
  }

  const householdIdFilter = req.nextUrl.searchParams.get("householdId");
  if (householdIdFilter && !adminHouseholdIds.includes(householdIdFilter)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const invites = await prisma.householdInvite.findMany({
    where: {
      householdId: householdIdFilter ?? { in: adminHouseholdIds },
    },
    include: {
      household: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      claimedBy: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return NextResponse.json(
    invites.map((invite) => ({
      ...invite,
      invitePath: `/household-invite/${invite.token}`,
    }))
  );
}

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const householdId =
    typeof body?.householdId === "string" ? body.householdId.trim() : "";
  const displayName =
    typeof body?.displayName === "string" ? body.displayName.trim() : "";
  const email = normalizeEmail(body?.email);
  const expiresInDaysRaw =
    typeof body?.expiresInDays === "number" ? body.expiresInDays : DEFAULT_EXPIRY_DAYS;
  const expiresInDays = Math.max(
    1,
    Math.min(MAX_EXPIRY_DAYS, Math.trunc(expiresInDaysRaw))
  );

  if (!householdId) {
    return NextResponse.json(
      { error: "householdId is required" },
      { status: 400 }
    );
  }

  const canManageHousehold = await isUserAdminForHousehold(userId, householdId);
  if (!canManageHousehold) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiresInDays);

  const invite = await prisma.householdInvite.create({
    data: {
      householdId,
      createdByUserId: userId,
      displayName: displayName || null,
      email,
      role: "member",
      status: "pending",
      expiresAt,
    },
    include: {
      household: { select: { id: true, name: true } },
    },
  });

  return NextResponse.json({
    ...invite,
    invitePath: `/household-invite/${invite.token}`,
  });
}
