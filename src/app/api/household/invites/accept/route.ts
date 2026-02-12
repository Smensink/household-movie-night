import { NextRequest, NextResponse } from "next/server";
import { hash } from "bcryptjs";
import { prisma } from "@/lib/prisma";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);

  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const email =
    typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!token || !name || !email || !password) {
    return NextResponse.json(
      { error: "token, name, email, and password are required" },
      { status: 400 }
    );
  }
  if (!EMAIL_REGEX.test(email)) {
    return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
  }
  if (password.length < 6) {
    return NextResponse.json(
      { error: "Password must be at least 6 characters" },
      { status: 400 }
    );
  }

  const invite = await prisma.householdInvite.findUnique({
    where: { token },
    include: {
      household: { select: { id: true, name: true } },
    },
  });

  if (!invite) {
    return NextResponse.json({ error: "Invite not found" }, { status: 404 });
  }

  const expired =
    Boolean(invite.expiresAt) && (invite.expiresAt as Date).getTime() < Date.now();
  if (invite.status !== "pending" || expired) {
    return NextResponse.json(
      { error: "Invite is no longer active" },
      { status: 400 }
    );
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json(
      { error: "Email already registered" },
      { status: 409 }
    );
  }

  const passwordHash = await hash(password, 12);

  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name,
        email,
        passwordHash,
      },
    });

    await tx.householdMember.create({
      data: {
        userId: user.id,
        householdId: invite.householdId,
        role: "member",
      },
    });

    await tx.householdInvite.update({
      where: { id: invite.id },
      data: {
        claimedAt: new Date(),
        claimedByUserId: user.id,
        status: "claimed",
      },
    });

    return user;
  });

  return NextResponse.json({
    id: created.id,
    email: created.email,
    name: created.name,
    household: invite.household,
  });
}
