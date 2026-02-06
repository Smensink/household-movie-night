import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const memberships = await prisma.householdMember.findMany({
    where: { userId: session.user.id },
    include: {
      household: {
        include: {
          members: {
            include: { user: { select: { id: true, name: true, avatarUrl: true } } },
          },
        },
      },
    },
  });

  return NextResponse.json(memberships.map((m) => ({
    ...m.household,
    role: m.role,
  })));
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { name } = await req.json();
  if (!name) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const household = await prisma.household.create({
    data: {
      name,
      members: {
        create: {
          userId: session.user.id,
          role: "admin",
        },
      },
    },
    include: { members: true },
  });

  return NextResponse.json(household);
}
