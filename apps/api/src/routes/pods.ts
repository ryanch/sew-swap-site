import { randomUUID } from 'node:crypto';
import { Spanner, type Database, type Transaction } from '@google-cloud/spanner';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '../auth/plugin';
import { database } from '../db/spanner';
import { toCsv } from '../pods/csv';
import { planLoop, type Edge } from '../pods/loop';
import { planSplit } from '../pods/split';
import { canManage, getSwap, swapParamsSchema } from '../swaps/access';

// Everything here is the swap manager's private view: skill levels, pods and who makes for whom
// are never sent to participants. Every route answers 404 for a missing swap and 403 unless the
// caller manages it (that swap's managers and admins).

/** A maker can make for up to this many people (the CSV has a column for each). */
export const MAX_RECIPIENTS = 5;

/** Pod ids are UUIDs; this stands for "no pod", the Default pod every new sign-up is in. */
const DEFAULT_POD = 'default';
const DEFAULT_POD_NAME = 'Default';

const NAME_SQL = `COALESCE(NULLIF(u.DisplayName, ''), NULLIF(p.RecipientName, ''), u.Email)`;

type MemberRow = {
  UserId: string;
  Email: string;
  DisplayName: string | null;
  Name: string;
  JoinedAt: string;
  InstagramHandle: string | null;
  InstagramStatus: string | null;
  SkillLevel: number | null;
  PodId: string | null;
  PodName: string | null;
  RecipientName: string | null;
  AddressLine1: string | null;
  AddressLine2: string | null;
  City: string | null;
  Region: string | null;
  PostalCode: string | null;
  Country: string | null;
};

type Person = { userId: string; name: string; instagramHandle: string | null };

export type MemberFilters = {
  userId?: string;
  pod?: string;
  exceptPod?: string;
  q?: string;
  country?: string;
  region?: string;
  skill?: string;
  needs?: 'maker' | 'recipient';
};

const filterProperties = {
  pod: { type: 'string', maxLength: 36 },
  exceptPod: { type: 'string', maxLength: 36 },
  q: { type: 'string', maxLength: 200 },
  country: { type: 'string', maxLength: 2 },
  region: { type: 'string', maxLength: 100 },
  skill: { type: 'string', enum: ['1', '2', '3', '4', '5', 'none'] },
  needs: { type: 'string', enum: ['maker', 'recipient'] },
} as const;

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The WHERE clause and params for participants of a swap matching `f`. */
function memberWhere(swapId: string, f: MemberFilters) {
  const where = [`m.SwapId = @swapId`, `m.Role = 'participant'`];
  const params: Record<string, unknown> = { swapId };
  if (f.userId) {
    where.push('m.UserId = @userId');
    params.userId = f.userId;
  }
  if (f.pod) {
    where.push(f.pod === DEFAULT_POD ? 'm.PodId IS NULL' : 'm.PodId = @pod');
    if (f.pod !== DEFAULT_POD) params.pod = f.pod;
  }
  if (f.exceptPod) {
    where.push(f.exceptPod === DEFAULT_POD ? 'm.PodId IS NOT NULL' : '(m.PodId IS NULL OR m.PodId != @exceptPod)');
    if (f.exceptPod !== DEFAULT_POD) params.exceptPod = f.exceptPod;
  }
  const q = f.q?.trim().toLowerCase().replace(/^@/, '');
  if (q) {
    where.push(`(LOWER(u.Email) LIKE @q OR LOWER(${NAME_SQL}) LIKE @q OR LOWER(IFNULL(p.InstagramHandle, '')) LIKE @q)`);
    params.q = `%${likeEscape(q)}%`;
  }
  if (f.country) {
    where.push('p.Country = @country');
    params.country = f.country.toUpperCase();
  }
  if (f.region?.trim()) {
    where.push('LOWER(p.Region) = @region');
    params.region = f.region.trim().toLowerCase();
  }
  if (f.skill === 'none') where.push('m.SkillLevel IS NULL');
  else if (f.skill) {
    where.push('m.SkillLevel = @skill');
    params.skill = Spanner.int(Number(f.skill));
  }
  if (f.needs === 'maker') {
    where.push('NOT EXISTS (SELECT 1 FROM Assignments a WHERE a.SwapId = m.SwapId AND a.RecipientId = m.UserId)');
  } else if (f.needs === 'recipient') {
    where.push('NOT EXISTS (SELECT 1 FROM Assignments a WHERE a.SwapId = m.SwapId AND a.MakerId = m.UserId)');
  }
  return { sql: where.join(' AND '), params };
}

const MEMBER_FROM = `FROM SwapMembers m JOIN Users u ON u.UserId = m.UserId
  LEFT JOIN UserProfiles p ON p.UserId = m.UserId
  LEFT JOIN Pods pd ON pd.SwapId = m.SwapId AND pd.PodId = m.PodId`;

/** One page of participants, keyset-paginated on UserId, with how many match in total. */
async function queryMembers(
  runner: Database | Transaction,
  swapId: string,
  f: MemberFilters,
  page: { after?: string; limit: number },
) {
  const where = memberWhere(swapId, f);
  const [rows] = await runner.run({
      sql: `SELECT m.UserId, u.Email, u.DisplayName, ${NAME_SQL} AS Name,
                   FORMAT_TIMESTAMP('%FT%TZ', m.CreatedAt) AS JoinedAt,
                   p.InstagramHandle, p.InstagramStatus, m.SkillLevel, m.PodId, pd.Name AS PodName,
                   p.RecipientName, p.AddressLine1, p.AddressLine2, p.City, p.Region, p.PostalCode, p.Country
            ${MEMBER_FROM}
            WHERE ${where.sql} AND m.UserId > @after
            ORDER BY m.UserId
            LIMIT @limit`,
      params: { ...where.params, after: page.after ?? '', limit: Spanner.int(page.limit + 1) },
      json: true,
    });
  const [counts] = await runner.run({ sql: `SELECT COUNT(*) AS Total ${MEMBER_FROM} WHERE ${where.sql}`, params: where.params, json: true });
  const list = (rows as MemberRow[]).slice(0, page.limit);
  return {
    rows: list,
    total: Number((counts[0] as { Total: number }).Total),
    nextCursor: rows.length > page.limit ? list[list.length - 1].UserId : null,
  };
}

/** Who each of `userIds` makes for and who makes for them, with names and Instagram for display. */
async function pairingsFor(runner: Database | Transaction, swapId: string, userIds: string[]) {
  const makingFor = new Map<string, Person[]>();
  const madeBy = new Map<string, Person[]>();
  if (userIds.length === 0) return { makingFor, madeBy };
  const [rows] = await runner.run({
    sql: `SELECT MakerId, RecipientId FROM Assignments
          WHERE SwapId = @swapId AND (MakerId IN UNNEST(@ids) OR RecipientId IN UNNEST(@ids))`,
    params: { swapId, ids: userIds },
    json: true,
  });
  const pairs = rows as { MakerId: string; RecipientId: string }[];
  if (pairs.length === 0) return { makingFor, madeBy };
  const people = await lookupPeople(runner, [...new Set(pairs.flatMap((r) => [r.MakerId, r.RecipientId]))]);
  const add = (map: Map<string, Person[]>, key: string, other: string) => map.set(key, [...(map.get(key) ?? []), people.get(other)!]);
  const ids = new Set(userIds);
  for (const r of pairs) {
    if (ids.has(r.MakerId)) add(makingFor, r.MakerId, r.RecipientId);
    if (ids.has(r.RecipientId)) add(madeBy, r.RecipientId, r.MakerId);
  }
  for (const list of [...makingFor.values(), ...madeBy.values()]) list.sort((x, y) => x.name.localeCompare(y.name));
  return { makingFor, madeBy };
}

async function lookupPeople(runner: Database | Transaction, userIds: string[]) {
  const [rows] = await runner.run({
    sql: `SELECT u.UserId, ${NAME_SQL} AS Name, p.InstagramHandle
          FROM Users u LEFT JOIN UserProfiles p ON p.UserId = u.UserId WHERE u.UserId IN UNNEST(@ids)`,
    params: { ids: userIds },
    json: true,
  });
  return new Map(
    (rows as { UserId: string; Name: string; InstagramHandle: string | null }[]).map((r) => [
      r.UserId,
      { userId: r.UserId, name: r.Name, instagramHandle: r.InstagramHandle },
    ]),
  );
}

function toMember(r: MemberRow, pairs: Awaited<ReturnType<typeof pairingsFor>>) {
  return {
    userId: r.UserId,
    email: r.Email,
    displayName: r.DisplayName,
    name: r.Name,
    joinedAt: r.JoinedAt,
    instagramHandle: r.InstagramHandle,
    // Anything short of a confirmed public account is flagged for the manager.
    instagramConfirmed: r.InstagramStatus === 'public',
    skillLevel: r.SkillLevel === null ? null : Number(r.SkillLevel),
    pod: { podId: r.PodId ?? DEFAULT_POD, name: r.PodName ?? DEFAULT_POD_NAME },
    country: r.Country,
    region: r.Region,
    city: r.City,
    makingFor: pairs.makingFor.get(r.UserId) ?? [],
    madeBy: pairs.madeBy.get(r.UserId) ?? [],
  };
}

const swapParams = swapParamsSchema;
const withParams = (...names: string[]) =>
  ({
    type: 'object',
    required: ['swapId', ...names],
    properties: Object.fromEntries(['swapId', ...names].map((n) => [n, { type: 'string', maxLength: 36 }])),
  }) as const;

/** 404/403 guard shared by every route here. Returns true when the reply has been sent. */
async function refuse(req: FastifyRequest<{ Params: { swapId: string } }>, reply: FastifyReply) {
  if (!(await getSwap(req.params.swapId))) {
    reply.code(404).send({ error: 'That swap was not found.' });
    return true;
  }
  if (!(await canManage(req.user!, req.params.swapId))) {
    reply.code(403).send({ error: "You can't manage this swap." });
    return true;
  }
  return false;
}

type PodRow = { PodId: string; Name: string };

async function readPods(runner: Database | Transaction, swapId: string) {
  const [pods] = await runner.run({ sql: `SELECT PodId, Name FROM Pods WHERE SwapId = @swapId`, params: { swapId }, json: true });
  const [counts] = await runner.run({
      sql: `SELECT IFNULL(PodId, '${DEFAULT_POD}') AS PodId, COUNT(*) AS N FROM SwapMembers
            WHERE SwapId = @swapId AND Role = 'participant' GROUP BY PodId`,
      params: { swapId },
      json: true,
    });
  const count = new Map((counts as { PodId: string; N: number }[]).map((c) => [c.PodId, Number(c.N)]));
  const sorted = (pods as PodRow[]).sort((a, b) => a.Name.localeCompare(b.Name, undefined, { numeric: true }));
  return [
    { podId: DEFAULT_POD, name: DEFAULT_POD_NAME, count: count.get(DEFAULT_POD) ?? 0 },
    ...sorted.map((p) => ({ podId: p.PodId, name: p.Name, count: count.get(p.PodId) ?? 0 })),
  ];
}

/** Returns an error message, or null when `name` is free to use for a pod in this swap. */
async function podNameProblem(tx: Transaction, swapId: string, name: string, exceptPodId?: string) {
  if (!name) return 'Please give the pod a name.';
  if (name.length > 100) return 'Please use a shorter pod name.';
  if (name.toLowerCase() === DEFAULT_POD_NAME.toLowerCase()) return `"${DEFAULT_POD_NAME}" is already a pod.`;
  const [rows] = await tx.run({
    sql: `SELECT PodId FROM Pods WHERE SwapId = @swapId AND LOWER(Name) = @name`,
    params: { swapId, name: name.toLowerCase() },
    json: true,
  });
  return (rows as PodRow[]).some((r) => r.PodId !== exceptPodId) ? `There's already a pod called "${name}".` : null;
}

async function podExists(runner: Database | Transaction, swapId: string, podId: string) {
  if (podId === DEFAULT_POD) return true;
  const [rows] = await runner.run({
    sql: `SELECT 1 AS Ok FROM Pods WHERE SwapId = @swapId AND PodId = @podId`,
    params: { swapId, podId },
    json: true,
  });
  return rows.length > 0;
}

/** Which of `userIds` are participants of the swap. */
async function participantsAmong(runner: Database | Transaction, swapId: string, userIds: string[]) {
  if (userIds.length === 0) return new Set<string>();
  const [rows] = await runner.run({
    sql: `SELECT UserId FROM SwapMembers WHERE SwapId = @swapId AND Role = 'participant' AND UserId IN UNNEST(@ids)`,
    params: { swapId, ids: userIds },
    json: true,
  });
  return new Set((rows as { UserId: string }[]).map((r) => r.UserId));
}

const memberKey = (swapId: string, userId: string) => ({ SwapId: swapId, UserId: userId, Role: 'participant' });

class Problem extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** Runs a read-write transaction; a thrown Problem rolls it back and becomes an error reply. */
async function inTransaction<T>(reply: FastifyReply, work: (tx: Transaction) => Promise<T>) {
  try {
    return await database.runTransactionAsync(async (tx) => {
      try {
        const result = await work(tx);
        await tx.commit();
        return result;
      } catch (err) {
        if (err instanceof Problem) await tx.rollback();
        throw err;
      }
    });
  } catch (err) {
    if (err instanceof Problem) {
      reply.code(err.status).send({ error: err.message });
      return undefined;
    }
    throw err;
  }
}

export async function podRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireAuth };

  app.get<{ Params: { swapId: string }; Querystring: MemberFilters & { limit?: number; after?: string } }>(
    '/api/swaps/:swapId/members',
    {
      ...auth,
      schema: {
        params: swapParams,
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
            after: { type: 'string', maxLength: 36 },
            ...filterProperties,
          },
        },
      },
    },
    async (req, reply) => {
      if (await refuse(req, reply)) return reply;
      const { limit = 100, after, ...filters } = req.query;
      const page = await queryMembers(database, req.params.swapId, filters, { after, limit });
      const pairs = await pairingsFor(database, req.params.swapId, page.rows.map((r) => r.UserId));
      return { members: page.rows.map((r) => toMember(r, pairs)), total: page.total, nextCursor: page.nextCursor };
    },
  );

  app.get<{ Params: { swapId: string; userId: string } }>(
    '/api/swaps/:swapId/members/:userId',
    { ...auth, schema: { params: withParams('userId') } },
    async (req, reply) => {
      if (await refuse(req, reply)) return reply;
      const { swapId, userId } = req.params;
      const { rows } = await queryMembers(database, swapId, { userId }, { limit: 1 });
      if (!rows[0]) return reply.code(404).send({ error: "That person isn't in this swap." });
      const r = rows[0];
      return {
        member: {
          ...toMember(r, await pairingsFor(database, swapId, [userId])),
          address: r.Country
            ? {
                name: r.RecipientName ?? '',
                line1: r.AddressLine1 ?? '',
                line2: r.AddressLine2 ?? '',
                city: r.City ?? '',
                region: r.Region ?? '',
                postalCode: r.PostalCode ?? '',
                country: r.Country,
              }
            : null,
        },
      };
    },
  );

  app.patch<{ Params: { swapId: string; userId: string }; Body: { skillLevel: number | null } }>(
    '/api/swaps/:swapId/members/:userId',
    {
      ...auth,
      schema: {
        params: withParams('userId'),
        body: {
          type: 'object',
          required: ['skillLevel'],
          additionalProperties: false,
          properties: { skillLevel: { type: ['integer', 'null'], minimum: 1, maximum: 5 } },
        },
      },
    },
    async (req, reply) => {
      if (await refuse(req, reply)) return reply;
      const { swapId, userId } = req.params;
      const done = await inTransaction(reply, async (tx) => {
        if (!(await participantsAmong(tx, swapId, [userId])).has(userId)) {
          throw new Problem("That person isn't in this swap.", 404);
        }
        tx.update('SwapMembers', { ...memberKey(swapId, userId), SkillLevel: req.body.skillLevel });
        return true;
      });
      return done && { skillLevel: req.body.skillLevel };
    },
  );

  app.get<{ Params: { swapId: string } }>('/api/swaps/:swapId/pods', { ...auth, schema: { params: swapParams } }, async (req, reply) => {
    if (await refuse(req, reply)) return reply;
    return { pods: await readPods(database, req.params.swapId) };
  });

  const nameBody = {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: { name: { type: 'string', maxLength: 200 } },
  } as const;

  app.post<{ Params: { swapId: string }; Body: { name: string } }>(
    '/api/swaps/:swapId/pods',
    { ...auth, schema: { params: swapParams, body: nameBody } },
    async (req, reply) => {
      if (await refuse(req, reply)) return reply;
      const { swapId } = req.params;
      const name = req.body.name.trim();
      const podId = randomUUID();
      const done = await inTransaction(reply, async (tx) => {
        const problem = await podNameProblem(tx, swapId, name);
        if (problem) throw new Problem(problem);
        tx.insert('Pods', { SwapId: swapId, PodId: podId, Name: name, CreatedAt: Spanner.COMMIT_TIMESTAMP });
        return true;
      });
      return done && reply.code(201).send({ pod: { podId, name, count: 0 } });
    },
  );

  app.patch<{ Params: { swapId: string; podId: string }; Body: { name: string } }>(
    '/api/swaps/:swapId/pods/:podId',
    { ...auth, schema: { params: withParams('podId'), body: nameBody } },
    async (req, reply) => {
      if (await refuse(req, reply)) return reply;
      const { swapId, podId } = req.params;
      const name = req.body.name.trim();
      const done = await inTransaction(reply, async (tx) => {
        if (podId === DEFAULT_POD) throw new Problem(`The ${DEFAULT_POD_NAME} pod can't be renamed.`);
        if (!(await podExists(tx, swapId, podId))) throw new Problem('That pod was not found.', 404);
        const problem = await podNameProblem(tx, swapId, name, podId);
        if (problem) throw new Problem(problem);
        tx.update('Pods', { SwapId: swapId, PodId: podId, Name: name });
        return true;
      });
      return done && { pod: { podId, name } };
    },
  );

  // People in a deleted pod go back to Default. Who they make for doesn't change.
  app.delete<{ Params: { swapId: string; podId: string } }>(
    '/api/swaps/:swapId/pods/:podId',
    { ...auth, schema: { params: withParams('podId') } },
    async (req, reply) => {
      if (await refuse(req, reply)) return reply;
      const { swapId, podId } = req.params;
      const done = await inTransaction(reply, async (tx) => {
        if (podId === DEFAULT_POD) throw new Problem(`The ${DEFAULT_POD_NAME} pod can't be deleted.`);
        if (!(await podExists(tx, swapId, podId))) throw new Problem('That pod was not found.', 404);
        await movePodMembers(tx, swapId, podId, null);
        tx.deleteRows('Pods', [[swapId, podId]]);
        return true;
      });
      return done && reply.code(204).send();
    },
  );

  app.put<{ Params: { swapId: string; podId: string }; Body: { userIds: string[] } }>(
    '/api/swaps/:swapId/pods/:podId/members',
    {
      ...auth,
      schema: {
        params: withParams('podId'),
        body: {
          type: 'object',
          required: ['userIds'],
          additionalProperties: false,
          properties: { userIds: { type: 'array', maxItems: 500, items: { type: 'string', maxLength: 36 } } },
        },
      },
    },
    async (req, reply) => {
      if (await refuse(req, reply)) return reply;
      const { swapId, podId } = req.params;
      const moved = await inTransaction(reply, async (tx) => {
        if (!(await podExists(tx, swapId, podId))) throw new Problem('That pod was not found.', 404);
        const members = await participantsAmong(tx, swapId, [...new Set(req.body.userIds)]);
        for (const userId of members) {
          tx.update('SwapMembers', { ...memberKey(swapId, userId), PodId: podId === DEFAULT_POD ? null : podId });
        }
        return members.size;
      });
      return moved !== undefined && { moved };
    },
  );

  app.post<{ Params: { swapId: string; podId: string }; Body: { size: number } }>(
    '/api/swaps/:swapId/pods/:podId/split',
    {
      ...auth,
      schema: {
        params: withParams('podId'),
        body: {
          type: 'object',
          required: ['size'],
          additionalProperties: false,
          properties: { size: { type: 'integer', minimum: 2, maximum: 500 } },
        },
      },
    },
    async (req, reply) => {
      if (await refuse(req, reply)) return reply;
      const { swapId, podId } = req.params;
      const { size } = req.body;
      const created = await inTransaction(reply, async (tx) => {
        const pods = await readPods(tx, swapId);
        const pod = pods.find((p) => p.podId === podId);
        if (!pod) throw new Problem('That pod was not found.', 404);
        const { rows } = await queryMembers(tx, swapId, { pod: podId }, { limit: 10_000 });
        if (rows.length <= size) {
          throw new Problem(`This pod has ${rows.length} ${rows.length === 1 ? 'person' : 'people'}, so it's already that size or smaller.`);
        }
        const plan = planSplit(
          rows.map((r) => ({
            userId: r.UserId,
            skillLevel: r.SkillLevel === null ? null : Number(r.SkillLevel),
            country: r.Country,
            region: r.Region,
            postalCode: r.PostalCode,
          })),
          size,
          pod.name,
          pods.filter((p) => p.podId !== podId).map((p) => p.name),
        );
        const made = plan.map((p) => ({ podId: randomUUID(), name: p.name, count: p.userIds.length, userIds: p.userIds }));
        for (const p of made) {
          tx.insert('Pods', { SwapId: swapId, PodId: p.podId, Name: p.name, CreatedAt: Spanner.COMMIT_TIMESTAMP });
          for (const userId of p.userIds) tx.update('SwapMembers', { ...memberKey(swapId, userId), PodId: p.podId });
        }
        // The old pod is empty now. Default always stays.
        if (podId !== DEFAULT_POD) tx.deleteRows('Pods', [[swapId, podId]]);
        return made.map(({ userIds: _, ...p }) => p);
      });
      return created && { pods: created };
    },
  );

  app.post<{ Params: { swapId: string; podId: string } }>(
    '/api/swaps/:swapId/pods/:podId/auto-assign',
    { ...auth, schema: { params: withParams('podId') } },
    async (req, reply) => {
      if (await refuse(req, reply)) return reply;
      const { swapId, podId } = req.params;
      const userId = req.user!.userId;
      const result = await inTransaction(reply, async (tx) => {
        if (!(await podExists(tx, swapId, podId))) throw new Problem('That pod was not found.', 404);
        const { rows } = await queryMembers(tx, swapId, { pod: podId }, { limit: 10_000 });
        const [edges] = await tx.run({
          sql: `SELECT MakerId AS makerId, RecipientId AS recipientId FROM Assignments WHERE SwapId = @swapId`,
          params: { swapId },
          json: true,
        });
        const plan = planLoop(rows.map((r) => r.UserId), edges as Edge[]);
        for (const e of plan.add) {
          tx.insert('Assignments', {
            SwapId: swapId,
            MakerId: e.makerId,
            RecipientId: e.recipientId,
            CreatedBy: userId,
            CreatedAt: Spanner.COMMIT_TIMESTAMP,
          });
        }
        const name = new Map(rows.map((r) => [r.UserId, r.Name]));
        const problems = [
          ...plan.unmatchedMakers.map((id) => `${name.get(id)} isn't making for anyone yet.`),
          ...plan.unmatchedRecipients.map((id) => `Nobody is making for ${name.get(id)} yet.`),
        ];
        if (rows.length < 2 && problems.length) problems.unshift('A pod needs at least 2 people to make a loop.');
        return {
          added: plan.add.map((e) => ({ maker: name.get(e.makerId), recipient: name.get(e.recipientId) })),
          problems,
        };
      });
      return result;
    },
  );

  app.put<{ Params: { swapId: string; makerId: string; recipientId: string } }>(
    '/api/swaps/:swapId/assignments/:makerId/:recipientId',
    { ...auth, schema: { params: withParams('makerId', 'recipientId') } },
    async (req, reply) => {
      if (await refuse(req, reply)) return reply;
      const { swapId, makerId, recipientId } = req.params;
      const userId = req.user!.userId;
      const done = await inTransaction(reply, async (tx) => {
        if (makerId === recipientId) throw new Problem("Someone can't make for themselves.");
        const members = await participantsAmong(tx, swapId, [makerId, recipientId]);
        if (members.size < 2) throw new Problem('Both people need to be in this swap.');
        const [current] = await tx.run({
          sql: `SELECT RecipientId FROM Assignments WHERE SwapId = @swapId AND MakerId = @makerId`,
          params: { swapId, makerId },
          json: true,
        });
        const recipients = (current as { RecipientId: string }[]).map((r) => r.RecipientId);
        if (recipients.includes(recipientId)) return true;
        if (recipients.length >= MAX_RECIPIENTS) {
          const maker = (await lookupPeople(tx, [makerId])).get(makerId)!;
          throw new Problem(`${maker.name} already makes for ${MAX_RECIPIENTS} people.`);
        }
        tx.insert('Assignments', {
          SwapId: swapId,
          MakerId: makerId,
          RecipientId: recipientId,
          CreatedBy: userId,
          CreatedAt: Spanner.COMMIT_TIMESTAMP,
        });
        return true;
      });
      return done && { assigned: true };
    },
  );

  app.delete<{ Params: { swapId: string; makerId: string; recipientId: string } }>(
    '/api/swaps/:swapId/assignments/:makerId/:recipientId',
    { ...auth, schema: { params: withParams('makerId', 'recipientId') } },
    async (req, reply) => {
      if (await refuse(req, reply)) return reply;
      const { swapId, makerId, recipientId } = req.params;
      await database.table('Assignments').deleteRows([[swapId, makerId, recipientId]]);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { swapId: string } }>(
    '/api/swaps/:swapId/export.csv',
    { ...auth, schema: { params: swapParams } },
    async (req, reply) => {
      if (await refuse(req, reply)) return reply;
      const { swapId } = req.params;
      const swap = (await getSwap(swapId))!;
      const { rows } = await queryMembers(database, swapId, {}, { limit: 100_000 });
      const pairs = await pairingsFor(database, swapId, rows.map((r) => r.UserId));
      const label = (p: Person) => (p.instagramHandle ? `${p.name} (@${p.instagramHandle})` : p.name);
      const members = rows
        .map((r) => toMember(r, pairs))
        .sort(
          (a, b) =>
            Number(a.pod.podId !== DEFAULT_POD) - Number(b.pod.podId !== DEFAULT_POD) ||
            a.pod.name.localeCompare(b.pod.name, undefined, { numeric: true }) ||
            a.name.localeCompare(b.name),
        );
      const byId = new Map(rows.map((r) => [r.UserId, r]));
      const csv = toCsv([
        [
          'Name', 'Email', 'Instagram', 'Instagram link', 'Instagram confirmed', 'Name on package',
          'Address line 1', 'Address line 2', 'City', 'State/Region', 'Postal code', 'Country',
          'Pod', 'Skill level', 'Making For',
          ...Array.from({ length: MAX_RECIPIENTS - 1 }, (_, i) => `Making For ${i + 2}`),
          'Made by',
        ],
        ...members.map((m) => {
          const r = byId.get(m.userId)!;
          return [
            m.name,
            m.email,
            m.instagramHandle ? `@${m.instagramHandle}` : '',
            m.instagramHandle ? `https://www.instagram.com/${m.instagramHandle}/` : '',
            m.instagramConfirmed ? 'Yes' : 'No',
            r.RecipientName,
            r.AddressLine1,
            r.AddressLine2,
            r.City,
            r.Region,
            r.PostalCode,
            r.Country,
            m.pod.name,
            m.skillLevel,
            ...Array.from({ length: MAX_RECIPIENTS }, (_, i) => (m.makingFor[i] ? label(m.makingFor[i]) : '')),
            m.madeBy.map(label).join('; '),
          ];
        }),
      ]);
      const file = `${swap.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'swap'}-makers.csv`;
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${file}"`)
        .send(csv);
    },
  );
}

/** Moves everyone in `fromPodId` to `toPodId` (null = Default), inside the caller's transaction. */
async function movePodMembers(tx: Transaction, swapId: string, fromPodId: string, toPodId: string | null) {
  const [rows] = await tx.run({
    sql: `SELECT UserId FROM SwapMembers WHERE SwapId = @swapId AND Role = 'participant' AND PodId = @podId`,
    params: { swapId, podId: fromPodId },
    json: true,
  });
  for (const r of rows as { UserId: string }[]) tx.update('SwapMembers', { ...memberKey(swapId, r.UserId), PodId: toPodId });
}
