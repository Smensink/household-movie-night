import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

function createPrismaClient() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
  });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

const prisma = createPrismaClient();

const RENAMES: Record<string, string> = {
  "The Adventure Enthusiast 2": "The Superhero Time-Travel Voyager",
  "The Drama Enthusiast 5": "The Classic Prestige Crime Canon",
  "The Action Enthusiast": "The Neo-Noir Adrenaline Mixer",
  "The Drama Enthusiast 3": "The Cult Space & Coen Curator",
  "The Adventure Enthusiast 3": "The Awards-SciFi Crossover Seeker",
  "The Adventure Enthusiast": "The Stylized Prestige Adventurer",
  "The Drama Enthusiast": "The Psychological Character Study Buff",
  "The Action Enthusiast 2": "The Modern Blockbuster Optimist",
  "The Romance Enthusiast": "The Heartfelt Sci-Fi Thinker",
  "The Drama Enthusiast 2": "The Dark Mind-Bender Realist",
  "The Action Enthusiast 3": "The Fantasy Franchise Loyalist",
  "The Drama Enthusiast 4": "The Auteur Classic Noir Scholar",
};

async function main() {
  const archetypes = await prisma.viewerArchetype.findMany({
    select: { id: true, name: true },
  });
  const byName = new Map(archetypes.map((a) => [a.name, a]));

  const updates: Array<{ id: string; from: string; to: string }> = [];
  for (const [from, to] of Object.entries(RENAMES)) {
    const row = byName.get(from);
    if (!row) continue;
    updates.push({ id: row.id, from, to });
  }

  if (updates.length === 0) {
    console.log("No matching archetypes found for rename map.");
    return;
  }

  // Two-phase rename avoids unique name collisions during updates.
  for (const u of updates) {
    await prisma.viewerArchetype.update({
      where: { id: u.id },
      data: { name: `__tmp__${u.id}` },
    });
  }
  for (const u of updates) {
    await prisma.viewerArchetype.update({
      where: { id: u.id },
      data: { name: u.to },
    });
  }

  console.log(`Renamed ${updates.length} archetypes:`);
  for (const u of updates) {
    console.log(`- ${u.from} -> ${u.to}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
