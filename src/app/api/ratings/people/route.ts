import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logActivity } from "@/lib/matrix-factorization";

type PersonType = "actor" | "director";

async function resolvePersonId(
  personIdInput: string,
  personNameInput: string
): Promise<string | null> {
  if (personIdInput) {
    const personById = await prisma.person.findUnique({
      where: { id: personIdInput },
      select: { id: true },
    });
    if (personById) {
      return personById.id;
    }
  }

  const personName = personNameInput || personIdInput;
  if (!personName) {
    return null;
  }

  const existingByName = await prisma.person.findFirst({
    where: {
      name: {
        equals: personName,
        mode: "insensitive",
      },
    },
    select: { id: true },
  });

  if (existingByName) {
    return existingByName.id;
  }

  const created = await prisma.person.create({
    data: { name: personName },
    select: { id: true },
  });
  return created.id;
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [actorRatings, directorRatings] = await Promise.all([
    prisma.actorRating.findMany({
      where: { userId: session.user.id },
      include: { person: { select: { id: true, name: true } } },
    }),
    prisma.directorRating.findMany({
      where: { userId: session.user.id },
      include: { person: { select: { id: true, name: true } } },
    }),
  ]);

  return NextResponse.json({
    actors: actorRatings,
    directors: directorRatings,
  });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const personIdInput =
    typeof body?.personId === "string" ? body.personId.trim() : "";
  const personNameInput =
    typeof body?.personName === "string" ? body.personName.trim() : "";
  const type = body?.type as PersonType;
  const rating = typeof body?.rating === "number" ? body.rating : null;
  const notHeardOf = Boolean(body?.notHeardOf);

  if (!personIdInput && !personNameInput) {
    return NextResponse.json(
      { error: "Person ID or name required" },
      { status: 400 }
    );
  }

  if (type !== "actor" && type !== "director") {
    return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  }

  if (!notHeardOf && (rating === null || rating < 1 || rating > 5)) {
    return NextResponse.json(
      { error: "Rating must be between 1 and 5" },
      { status: 400 }
    );
  }

  const personId = await resolvePersonId(personIdInput, personNameInput);
  if (!personId) {
    return NextResponse.json({ error: "Invalid person" }, { status: 400 });
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
    await logActivity(session.user.id, "rating", "actor", personId);
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
    await logActivity(session.user.id, "rating", "director", personId);
    return NextResponse.json(directorRating);
  }

  return NextResponse.json({ error: "Invalid type" }, { status: 400 });
}
