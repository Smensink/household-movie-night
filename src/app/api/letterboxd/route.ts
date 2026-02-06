import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { importLetterboxdData } from "@/lib/api/letterboxd";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await req.formData();
  const file = formData.get("file") as File;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  const csvContent = await file.text();

  // Create import record
  const importRecord = await prisma.letterboxdImport.create({
    data: {
      userId: session.user.id,
      filename: file.name,
    },
  });

  // Process in background (non-blocking)
  importLetterboxdData(session.user.id, csvContent, importRecord.id).catch(
    async () => {
      await prisma.letterboxdImport.update({
        where: { id: importRecord.id },
        data: { status: "failed" },
      });
    }
  );

  return NextResponse.json({ importId: importRecord.id, status: "processing" });
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const imports = await prisma.letterboxdImport.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(imports);
}
