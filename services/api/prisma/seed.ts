import { PrismaClient } from '@prisma/client';
import { buildDefaultRegistry } from '@osint/connectors';
import { ensureLocalUser } from '../src/auth/localUser.js';

const prisma = new PrismaClient();

/**
 * Single-user local-first: there's no login, so there's nothing to seed a
 * password for. The API auto-provisions its one local account on startup
 * (auth/localUser.ts) — this reuses the exact same function rather than a
 * second, parallel "create an admin" path, so a fresh clone never ends up
 * with two different accounts depending on whether `db:seed` ran before or
 * after the API's first boot.
 */
async function main(): Promise<void> {
  // 1. connectors registry -> DB rows
  const registry = buildDefaultRegistry();
  for (const c of registry.all()) {
    const report = (c.capabilities as (x?: unknown) => { category: string }).call(c, null);
    await prisma.connector.upsert({
      where: { id: c.id },
      create: { id: c.id, displayName: c.displayName, category: report.category },
      update: { displayName: c.displayName, category: report.category },
    });
  }
  console.log(`✓ ${registry.ids().length} connectors registered`);

  // 2. the one local account
  const localUser = await ensureLocalUser();
  console.log(`✓ local account: ${localUser.email}`);

  // 3. demo project owned by the local account (only if none exist)
  if ((await prisma.project.count()) === 0) {
    await prisma.project.create({
      data: {
        name: 'Sample Investigation',
        slug: 'sample-investigation',
        objective: 'Explore the platform with the key-free connectors (Wikipedia, Hacker News, RSS, web fetch).',
        ownerId: localUser.id,
        defaultLanguages: 'en',
        members: { create: { userId: localUser.id, role: 'OWNER' } },
      },
    });
    console.log('✓ created "Sample Investigation" project');
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
