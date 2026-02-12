import { prisma } from "@/lib/prisma";

export async function isUserHouseholdAdmin(userId: string): Promise<boolean> {
  const membership = await prisma.householdMember.findFirst({
    where: { userId, role: "admin" },
    select: { id: true },
  });

  return Boolean(membership);
}

export async function isUserAdminForHousehold(
  userId: string,
  householdId: string
): Promise<boolean> {
  const membership = await prisma.householdMember.findUnique({
    where: {
      userId_householdId: {
        userId,
        householdId,
      },
    },
    select: { role: true },
  });

  return membership?.role === "admin";
}
