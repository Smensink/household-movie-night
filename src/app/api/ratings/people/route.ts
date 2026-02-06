import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { personId, type, rating, notHeardOf } = await req.json();

  if (!personId || !type) {
    return NextResponse.json(
      { error: "Person ID and type required" },
      { status: 400 }
    );
  }

  if (type === "actor") {
    const actorRating = await prisma.actorRating.upsert({
      where: {
        userId_personId: { userId: session.user.id, personId },
      },
      create: {
        userId: session.user.id,
        personId,
        rating: notHeardOf ? null : rating,
        notHeardOf: notHeardOf ?? false,
      },
      update: {
        rating: notHeardOf ? null : rating,
        notHeardOf: notHeardOf ?? false,
      },
    });
    return NextResponse.json(actorRating);
  }

  if (type === "director") {
    const directorRating = await prisma.directorRating.upsert({
      where: {
        userId_personId: { userId: session.user.id, personId },
      },
      create: {
        userId: session.user.id,
        personId,
        rating: notHeardOf ? null : rating,
        notHeardOf: notHeardOf ?? false,
      },
      update: {
        rating: notHeardOf ? null : rating,
        notHeardOf: notHeardOf ?? false,
      },
    });
    return NextResponse.json(directorRating);
  }

  return NextResponse.json({ error: "Invalid type" }, { status: 400 });
}
