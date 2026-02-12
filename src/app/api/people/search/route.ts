import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const q = req.nextUrl.searchParams.get("q")?.trim() || "";
  if (!q || q.length < 2) {
    return NextResponse.json([]);
  }

  const people = await prisma.person.findMany({
    where: {
      name: { contains: q, mode: "insensitive" },
    },
    select: { id: true, name: true, photoUrl: true, knownFor: true },
    take: 20,
    orderBy: { name: "asc" },
  });

  return NextResponse.json(people);
}
