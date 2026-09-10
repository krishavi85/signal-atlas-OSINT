import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { buildDefaultRegistry } from '@osint/connectors';
import { hashPassword } from '../src/lib/password.js';

const prisma = new PrismaClient();

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

  // 2. admin user
  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@osint.local';
  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    const password = process.env.SEED_ADMIN_PASSWORD ?? randomBytes(9).toString('base64url');
    await prisma.user.create({
      data: { email, displayName: 'Administrator', passwordHash: await hashPassword(password), role: 'ADMIN' },
    });
    console.log('\n  Admin account created:');
    console.log(`    email:    ${email}`);
    console.log(`    password: ${password}`);
    console.log('  (set SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD to override)\n');
  } else {
    console.log(`✓ admin user ${email} already exists`);
  }

  // 3. demo project owned by admin (only if none exist)
  const admin = await prisma.user.findUniqueOrThrow({ where: { email } });
  if ((await prisma.project.count()) === 0) {
    await prisma.project.create({
      data: {
        name: 'Sample Investigation',
        slug: 'sample-investigation',
        objective: 'Explore the platform with the key-free connectors (Wikipedia, Hacker News, RSS, web fetch).',
        ownerId: admin.id,
        defaultLanguages: 'en',
        members: { create: { userId: admin.id, role: 'OWNER' } },
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
