import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { currentUser } from '../auth/plugin.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { audit } from './audit.js';

type ProjectRole = 'OWNER' | 'EDITOR' | 'VIEWER';
const RANK: Record<ProjectRole, number> = { VIEWER: 1, EDITOR: 2, OWNER: 3 };

export async function assertProjectAccess(
  req: FastifyRequest,
  projectId: string,
  minRole: ProjectRole = 'VIEWER',
): Promise<{ role: ProjectRole }> {
  const u = currentUser(req);
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: u.id } },
  });
  if (!member) {
    // admins can read any project
    if (u.role === 'ADMIN' && minRole === 'VIEWER') return { role: 'VIEWER' };
    throw notFound('Project not found');
  }
  const role = member.role as ProjectRole;
  if (RANK[role] < RANK[minRole]) throw forbidden(`Requires ${minRole} on this project`);
  return { role };
}

const CreateProject = z.object({
  name: z.string().min(1).max(200),
  objective: z.string().max(2000).optional(),
  defaultLanguages: z.array(z.string().min(2).max(8)).default(['en']),
  dateRangeStart: z.string().datetime().optional(),
  dateRangeEnd: z.string().datetime().optional(),
  retentionDays: z.number().int().positive().max(3650).nullable().optional(),
});

const UpdateProject = CreateProject.partial().extend({
  status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']).optional(),
});

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'project'
  );
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.get('/projects', async (req) => {
    const u = currentUser(req);
    const memberships = await prisma.projectMember.findMany({
      where: { userId: u.id },
      include: {
        project: {
          include: {
            _count: { select: { evidence: true, entities: true, searches: true, monitoringJobs: true } },
          },
        },
      },
      orderBy: { project: { updatedAt: 'desc' } },
    });
    return memberships.map((m) => ({ ...m.project, myRole: m.role }));
  });

  app.post('/projects', async (req, reply) => {
    const u = currentUser(req);
    const input = CreateProject.parse(req.body);
    let slug = slugify(input.name);
    if (await prisma.project.findUnique({ where: { slug } })) slug = `${slug}-${Date.now().toString(36)}`;

    const project = await prisma.project.create({
      data: {
        name: input.name,
        slug,
        objective: input.objective,
        defaultLanguages: input.defaultLanguages.join(','),
        dateRangeStart: input.dateRangeStart ? new Date(input.dateRangeStart) : null,
        dateRangeEnd: input.dateRangeEnd ? new Date(input.dateRangeEnd) : null,
        retentionDays: input.retentionDays ?? null,
        ownerId: u.id,
        members: { create: { userId: u.id, role: 'OWNER' } },
      },
    });
    await audit({
      projectId: project.id,
      actorId: u.id,
      actorLabel: `user:${u.email}`,
      action: 'PROJECT_CREATED',
      targetType: 'project',
      targetId: project.id,
      summary: `Created project "${project.name}"`,
    });
    reply.status(201).send(project);
  });

  app.get('/projects/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { role } = await assertProjectAccess(req, id);
    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            evidence: true, entities: true, searches: true, relationships: true,
            claims: true, timelineEvents: true, monitoringJobs: true, documents: true,
            media: true, notes: true, reports: true,
          },
        },
        members: { include: { user: { select: { id: true, email: true, displayName: true } } } },
      },
    });
    if (!project) throw notFound('Project not found');
    return { ...project, myRole: role };
  });

  app.patch('/projects/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id, 'EDITOR');
    const u = currentUser(req);
    const input = UpdateProject.parse(req.body);

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.objective !== undefined) data.objective = input.objective;
    if (input.defaultLanguages !== undefined) data.defaultLanguages = input.defaultLanguages.join(',');
    if (input.dateRangeStart !== undefined) data.dateRangeStart = input.dateRangeStart ? new Date(input.dateRangeStart) : null;
    if (input.dateRangeEnd !== undefined) data.dateRangeEnd = input.dateRangeEnd ? new Date(input.dateRangeEnd) : null;
    if (input.retentionDays !== undefined) data.retentionDays = input.retentionDays;
    if (input.status !== undefined) data.status = input.status;

    const project = await prisma.project.update({ where: { id }, data });
    const action =
      input.status === 'PAUSED' ? 'PROJECT_PAUSED'
      : input.status === 'ACTIVE' ? 'PROJECT_RESUMED'
      : input.status === 'ARCHIVED' ? 'PROJECT_ARCHIVED'
      : 'PROJECT_UPDATED';
    await audit({
      projectId: id, actorId: u.id, actorLabel: `user:${u.email}`, action,
      targetType: 'project', targetId: id, summary: `Updated project "${project.name}"`, metadata: { changed: Object.keys(data) },
    });
    return project;
  });

  // Membership (OWNER only)
  const MemberInput = z.object({ email: z.string().email(), role: z.enum(['EDITOR', 'VIEWER']) });
  app.post('/projects/:id/members', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id, 'OWNER');
    const u = currentUser(req);
    const input = MemberInput.parse(req.body);
    const target = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    if (!target) throw badRequest('No user with that email has registered');
    const member = await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: id, userId: target.id } },
      create: { projectId: id, userId: target.id, role: input.role },
      update: { role: input.role },
    });
    await audit({
      projectId: id, actorId: u.id, actorLabel: `user:${u.email}`, action: 'MEMBER_ADDED',
      targetType: 'user', targetId: target.id, summary: `Added ${input.email} as ${input.role}`,
    });
    reply.status(201).send(member);
  });

  app.delete('/projects/:id/members/:userId', async (req, reply) => {
    const { id, userId } = z.object({ id: z.string(), userId: z.string() }).parse(req.params);
    await assertProjectAccess(req, id, 'OWNER');
    const u = currentUser(req);
    const project = await prisma.project.findUniqueOrThrow({ where: { id } });
    if (project.ownerId === userId) throw badRequest('Cannot remove the project owner');
    await prisma.projectMember.deleteMany({ where: { projectId: id, userId } });
    await audit({
      projectId: id, actorId: u.id, actorLabel: `user:${u.email}`, action: 'MEMBER_REMOVED',
      targetType: 'user', targetId: userId, summary: `Removed member ${userId}`,
    });
    reply.status(204).send();
  });

  // Audit trail (§29)
  app.get('/projects/:id/audit', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const q = z.object({ limit: z.coerce.number().min(1).max(200).default(100), cursor: z.string().optional(), action: z.string().optional() }).parse(req.query);
    const rows = await prisma.auditLog.findMany({
      where: { projectId: id, ...(q.action ? { action: q.action } : {}) },
      orderBy: { createdAt: 'desc' },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { actor: { select: { email: true, displayName: true } } },
    });
    const nextCursor = rows.length > q.limit ? rows.pop()!.id : null;
    return { items: rows, nextCursor };
  });
}
