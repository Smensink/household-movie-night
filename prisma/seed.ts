import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const prisma = new PrismaClient({ adapter });

const genres = [
  { name: "Action", slug: "action" },
  { name: "Adventure", slug: "adventure" },
  { name: "Animation", slug: "animation" },
  { name: "Comedy", slug: "comedy" },
  { name: "Crime", slug: "crime" },
  { name: "Documentary", slug: "documentary" },
  { name: "Drama", slug: "drama" },
  { name: "Family", slug: "family" },
  { name: "Fantasy", slug: "fantasy" },
  { name: "History", slug: "history" },
  { name: "Horror", slug: "horror" },
  { name: "Music", slug: "music" },
  { name: "Mystery", slug: "mystery" },
  { name: "Romance", slug: "romance" },
  { name: "Science Fiction", slug: "science-fiction" },
  { name: "Thriller", slug: "thriller" },
  { name: "War", slug: "war" },
  { name: "Western", slug: "western" },
];

const studios = [
  { name: "A24", slug: "a24" },
  { name: "Lionsgate", slug: "lionsgate" },
  { name: "Warner Bros.", slug: "warner-bros" },
  { name: "Universal Pictures", slug: "universal" },
  { name: "Paramount Pictures", slug: "paramount" },
  { name: "20th Century Studios", slug: "20th-century" },
  { name: "Sony Pictures", slug: "sony" },
  { name: "Walt Disney Pictures", slug: "disney" },
  { name: "Marvel Studios", slug: "marvel" },
  { name: "Pixar", slug: "pixar" },
  { name: "DreamWorks", slug: "dreamworks" },
  { name: "Lucasfilm", slug: "lucasfilm" },
  { name: "New Line Cinema", slug: "new-line" },
  { name: "MGM", slug: "mgm" },
  { name: "Focus Features", slug: "focus-features" },
  { name: "Searchlight Pictures", slug: "searchlight" },
  { name: "Neon", slug: "neon" },
  { name: "Blumhouse", slug: "blumhouse" },
  { name: "Legendary Entertainment", slug: "legendary" },
  { name: "STX Entertainment", slug: "stx" },
  { name: "Annapurna Pictures", slug: "annapurna" },
  { name: "Plan B Entertainment", slug: "plan-b" },
  { name: "Studio Ghibli", slug: "studio-ghibli" },
  { name: "Miramax", slug: "miramax" },
  { name: "Lionsgate Films", slug: "lionsgate-films" },
];

async function main() {
  console.log("Seeding genres...");
  for (const genre of genres) {
    await prisma.genre.upsert({
      where: { slug: genre.slug },
      create: genre,
      update: {},
    });
  }
  console.log(`Seeded ${genres.length} genres`);

  console.log("Seeding studios...");
  for (const studio of studios) {
    await prisma.studio.upsert({
      where: { slug: studio.slug },
      create: studio,
      update: {},
    });
  }
  console.log(`Seeded ${studios.length} studios`);

  console.log("Seed complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
