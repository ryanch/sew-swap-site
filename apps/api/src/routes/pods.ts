import { randomUUID } from 'node:crypto';
import type { Query, Timestamp, Transaction } from '@google-cloud/firestore';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '../auth/plugin';
import { config } from '../config';
import { assignmentId, col, getMany, inTransaction, memberId, now, Problem, rows, toIso } from '../db/firestore';
import { loadPeople, lookupPeople, personName, type Person, type ProfileDoc, type UserDoc } from '../db/people';
import { sendUserMail } from '../email/mailer';
import { newPairingEmail } from '../email/templates';
import { toCsv } from '../pods/csv';
import { planLoop } from '../pods/loop';
import { planSplit } from '../pods/split';
import { addressView } from './profile';
import { carrierLabel, toShipment, type Shipment } from '../shipping/tracking';
import { canManage, getSwap, swapParamsSchema } from '../swaps/access';

// Everything here is the swap manager's private view: skill levels, pods and who makes for whom
// are never sent to participants. Every route answers 404 for a missing swap and 403 unless the
// caller manages it (that swap's managers and admins).

/** A maker can make for up to this many people (the CSV has a column for each). */
export const MAX_RECIPIENTS = 5;

/** Pod ids are UUIDs; this stands for "no pod", the Default pod every new sign-up is in. */
const DEFAULT_POD = 'default';
const DEFAULT_POD_NAME = 'Default';

type MemberDoc = {
  SwapId: string;
  UserId: string;
  Role: string;
  CreatedAt: Timestamp;
  SkillLevel?: number | null;
  PodId?: string | null;
};

type PodDoc = { SwapId: string; PodId: string; Name: string };

type AssignmentDoc = {
  SwapId: string;
  MakerId: string;
  RecipientId: string;
  ConfirmedAt?: Timestamp | null;
  ShippedAt?: Timestamp | null;
  Carrier?: string | null;
  TrackingNumber?: string | null;
};

type EmailLogDoc = { UserId: string; SentAt: Timestamp; Kind: string; Status: string };

/** A participant with their account and profile. */
type MemberRow = { UserId: string; member: MemberDoc; user: UserDoc; profile: ProfileDoc | null; name: string };

/** How someone is shown to the manager. */
type Shown = Omit<Person, 'email'>;

/**
 * Someone on the other end of a pairing. `confirmed` is whether the maker has confirmed it, and
 * `shipped` the package's tracking once the maker has sent it.
 */
type Paired = Shown & { confirmed: boolean; shipped: Shipment | null };

export type MemberFilters = {
  userId?: string;
  pod?: string;
  exceptPod?: string;
  q?: string;
  country?: string;
  region?: string;
  skill?: string;
  needs?: 'maker' | 'recipient' | 'confirmation' | 'shipping';
};

const filterProperties = {
  pod: { type: 'string', maxLength: 36 },
  exceptPod: { type: 'string', maxLength: 36 },
  q: { type: 'string', maxLength: 200 },
  country: { type: 'string', maxLength: 2 },
  region: { type: 'string', maxLength: 100 },
  skill: { type: 'string', enum: ['1', '2', '3', '4', '5', 'none'] },
  needs: { type: 'string', enum: ['maker', 'recipient', 'confirmation', 'shipping'] },
} as const;

const read = (q: Query, tx?: Transaction) => (tx ? tx.get(q) : q.get());
const participantsQuery = (swapId: string) => col.swapMembers.where('SwapId', '==', swapId).where('Role', '==', 'participant');

/** What a call needs besides the participants themselves. */
type Load = { people?: boolean; pods?: boolean; assignments?: boolean; reminders?: boolean };

/**
 * A swap's participants and whatever else `load` asks for, read together. Filtering, sorting and
 * counting happen in memory, so every query is a plain equality query. With `onlyUserId`, just
 * that person's member doc is read.
 */
async function loadSwap(swapId: string, load: Load, tx?: Transaction, onlyUserId?: string) {
  const [members, pods, assignments, emails] = await Promise.all([
    onlyUserId
      ? getMany<MemberDoc>(col.swapMembers, [memberId(swapId, onlyUserId, 'participant')], tx).then((m) => [...m.values()])
      : read(participantsQuery(swapId), tx).then((s) => rows<MemberDoc>(s)),
    load.pods ? read(col.pods.where('SwapId', '==', swapId), tx).then((s) => rows<PodDoc>(s)) : [],
    load.assignments ? read(col.assignments.where('SwapId', '==', swapId), tx).then((s) => rows<AssignmentDoc>(s)) : [],
    load.reminders
      ? read(col.emailLog.where('SwapId', '==', swapId).where('Kind', 'in', ['confirm_reminder', 'ship_reminder']), tx).then((s) =>
          rows<EmailLogDoc>(s),
        )
      : [],
  ]);
  const people = load.people ? await loadPeople(members.map((m) => m.UserId), tx) : { users: new Map(), profiles: new Map() };

  // The latest reminder of each kind that actually went out, per person.
  const reminded = { confirm_reminder: new Map<string, Timestamp>(), ship_reminder: new Map<string, Timestamp>() };
  for (const e of emails) {
    if (e.Status !== 'sent') continue;
    const map = reminded[e.Kind as keyof typeof reminded];
    const last = map.get(e.UserId);
    if (!last || e.SentAt.toMillis() > last.toMillis()) map.set(e.UserId, e.SentAt);
  }

  const memberRows: MemberRow[] = [];
  for (const m of members) {
    const user = people.users.get(m.UserId) as UserDoc | undefined;
    // Without people loaded, rows only carry the member doc (enough for pod counts).
    if (load.people && !user) continue;
    const profile = (people.profiles.get(m.UserId) as ProfileDoc | undefined) ?? null;
    memberRows.push({ UserId: m.UserId, member: m, user: user!, profile, name: user ? personName(user, profile) : '' });
  }
  memberRows.sort((a, b) => (a.UserId < b.UserId ? -1 : a.UserId > b.UserId ? 1 : 0));

  return {
    members: memberRows,
    pods: new Map(pods.map((p) => [p.PodId, p])),
    assignments,
    reminded,
  };
}

type SwapData = Awaited<ReturnType<typeof loadSwap>>;

const podOf = (m: MemberDoc) => m.PodId ?? null;

/** Whether a participant matches `f`. Needs people loaded, and assignments for `needs`. */
function matches(r: MemberRow, f: MemberFilters, assignments: AssignmentDoc[]) {
  const m = r.member;
  if (f.userId && r.UserId !== f.userId) return false;
  if (f.pod && (f.pod === DEFAULT_POD ? podOf(m) !== null : podOf(m) !== f.pod)) return false;
  if (f.exceptPod && (f.exceptPod === DEFAULT_POD ? podOf(m) === null : podOf(m) === f.exceptPod)) return false;
  const q = f.q?.trim().toLowerCase().replace(/^@/, '');
  if (q) {
    const fields = [r.user.Email, r.name, r.profile?.InstagramHandle ?? ''];
    if (!fields.some((s) => s.toLowerCase().includes(q))) return false;
  }
  if (f.country && r.profile?.Country !== f.country.toUpperCase()) return false;
  const region = f.region?.trim().toLowerCase();
  if (region && r.profile?.Region?.toLowerCase() !== region) return false;
  const skill = m.SkillLevel ?? null;
  if (f.skill === 'none' ? skill !== null : f.skill && skill !== Number(f.skill)) return false;
  if (f.needs) {
    const id = r.UserId;
    const has = (test: (a: AssignmentDoc) => boolean) => assignments.some(test);
    if (f.needs === 'maker' && has((a) => a.RecipientId === id)) return false;
    if (f.needs === 'recipient' && has((a) => a.MakerId === id)) return false;
    if (f.needs === 'confirmation' && !has((a) => a.MakerId === id && !a.ConfirmedAt)) return false;
    if (f.needs === 'shipping' && !has((a) => a.MakerId === id && !a.ShippedAt)) return false;
  }
  return true;
}

/** One page of participants, keyset-paginated on UserId, with how many match in total. */
async function queryMembers(swapId: string, f: MemberFilters, page: { after?: string; limit: number }, load: Load = {}, tx?: Transaction) {
  const data = await loadSwap(swapId, { ...load, people: true, assignments: load.assignments || !!f.needs }, tx, f.userId);
  const matching = data.members.filter((r) => matches(r, f, data.assignments));
  const after = page.after ?? '';
  const rest = matching.filter((r) => r.UserId > after);
  const list = rest.slice(0, page.limit);
  return {
    rows: list,
    total: matching.length,
    nextCursor: rest.length > page.limit ? list[list.length - 1].UserId : null,
    data,
  };
}

/** How many participants of the swap match `f`. */
export async function countMembers(swapId: string, f: MemberFilters, tx?: Transaction): Promise<number> {
  const data = await loadSwap(swapId, { people: true, assignments: !!f.needs }, tx, f.userId);
  return data.members.filter((r) => matches(r, f, data.assignments)).length;
}

/** Who each of `userIds` makes for and who makes for them, with names and Instagram for display. */
async function pairingsFor(data: SwapData, userIds: string[]) {
  const makingFor = new Map<string, Paired[]>();
  const madeBy = new Map<string, Paired[]>();
  const ids = new Set(userIds);
  const pairs = data.assignments.filter((a) => ids.has(a.MakerId) || ids.has(a.RecipientId));
  if (pairs.length === 0) return { makingFor, madeBy };
  const people = new Map<string, Shown>();
  for (const r of data.members) {
    people.set(r.UserId, { userId: r.UserId, name: r.name, instagramHandle: r.profile?.InstagramHandle ?? null });
  }
  const missing = pairs.flatMap((a) => [a.MakerId, a.RecipientId]).filter((id) => !people.has(id));
  for (const [id, p] of await lookupPeople(missing)) people.set(id, { userId: id, name: p.name, instagramHandle: p.instagramHandle });

  const add = (map: Map<string, Paired[]>, key: string, other: string, a: AssignmentDoc) =>
    map.set(key, [
      ...(map.get(key) ?? []),
      {
        ...people.get(other)!,
        confirmed: !!a.ConfirmedAt,
        shipped: toShipment({ ShippedAt: toIso(a.ShippedAt), Carrier: a.Carrier ?? null, TrackingNumber: a.TrackingNumber ?? null }),
      },
    ]);
  for (const a of pairs) {
    if (ids.has(a.MakerId)) add(makingFor, a.MakerId, a.RecipientId, a);
    if (ids.has(a.RecipientId)) add(madeBy, a.RecipientId, a.MakerId, a);
  }
  for (const list of [...makingFor.values(), ...madeBy.values()]) list.sort((x, y) => x.name.localeCompare(y.name));
  return { makingFor, madeBy };
}

function toMember(r: MemberRow, data: SwapData, pairs: Awaited<ReturnType<typeof pairingsFor>>) {
  const podId = podOf(r.member);
  return {
    userId: r.UserId,
    email: r.user.Email,
    displayName: r.user.DisplayName ?? null,
    name: r.name,
    joinedAt: toIso(r.member.CreatedAt),
    instagramHandle: r.profile?.InstagramHandle ?? null,
    // Anything short of a confirmed public account is flagged for the manager.
    instagramConfirmed: r.profile?.InstagramStatus === 'public',
    skillLevel: r.member.SkillLevel ?? null,
    pod: { podId: podId ?? DEFAULT_POD, name: (podId && data.pods.get(podId)?.Name) || DEFAULT_POD_NAME },
    country: r.profile?.Country ?? null,
    region: r.profile?.Region ?? null,
    city: r.profile?.City ?? null,
    makingFor: pairs.makingFor.get(r.UserId) ?? [],
    madeBy: pairs.madeBy.get(r.UserId) ?? [],
    lastRemindedAt: toIso(data.reminded.confirm_reminder.get(r.UserId)),
    lastShipRemindedAt: toIso(data.reminded.ship_reminder.get(r.UserId)),
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
export async function refuse(req: FastifyRequest<{ Params: { swapId: string } }>, reply: FastifyReply) {
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

/** Default first, then the swap's pods by name (numbers in order), each with how many people it has. */
function podList(data: SwapData) {
  const count = new Map<string, number>();
  for (const r of data.members) {
    const id = podOf(r.member) ?? DEFAULT_POD;
    count.set(id, (count.get(id) ?? 0) + 1);
  }
  const sorted = [...data.pods.values()].sort((a, b) => a.Name.localeCompare(b.Name, undefined, { numeric: true }));
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
  const pods = rows<PodDoc>(await tx.get(col.pods.where('SwapId', '==', swapId)));
  return pods.some((p) => p.PodId !== exceptPodId && p.Name.toLowerCase() === name.toLowerCase())
    ? `There's already a pod called "${name}".`
    : null;
}

async function podExists(tx: Transaction, swapId: string, podId: string) {
  if (podId === DEFAULT_POD) return true;
  const snap = await tx.get(col.pods.doc(podId));
  return snap.exists && (snap.data() as PodDoc).SwapId === swapId;
}

/** Which of `userIds` are participants of the swap. */
async function participantsAmong(tx: Transaction, swapId: string, userIds: string[]) {
  const found = await getMany<MemberDoc>(col.swapMembers, userIds.map((id) => memberId(swapId, id, 'participant')), tx);
  return new Set([...found.values()].map((m) => m.UserId));
}

const memberRef = (swapId: string, userId: string) => col.swapMembers.doc(memberId(swapId, userId, 'participant'));

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
      const page = await queryMembers(req.params.swapId, filters, { after, limit }, { pods: true, assignments: true, reminders: true });
      const pairs = await pairingsFor(page.data, page.rows.map((r) => r.UserId));
      return { members: page.rows.map((r) => toMember(r, page.data, pairs)), total: page.total, nextCursor: page.nextCursor };
    },
  );

  app.get<{ Params: { swapId: string; userId: string } }>(
    '/api/swaps/:swapId/members/:userId',
    { ...auth, schema: { params: withParams('userId') } },
    async (req, reply) => {
      if (await refuse(req, reply)) return reply;
      const { swapId, userId } = req.params;
      const { rows: found, data } = await queryMembers(swapId, { userId }, { limit: 1 }, { pods: true, assignments: true, reminders: true });
      if (!found[0]) return reply.code(404).send({ error: "That person isn't in this swap." });
      const r = found[0];
      const p = r.profile;
      return {
        member: {
          ...toMember(r, data, await pairingsFor(data, [userId])),
          address: p?.Country ? addressView(p) : null,
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
        tx.update(memberRef(swapId, userId), { SkillLevel: req.body.skillLevel });
        return true;
      });
      return done && { skillLevel: req.body.skillLevel };
    },
  );

  app.get<{ Params: { swapId: string } }>('/api/swaps/:swapId/pods', { ...auth, schema: { params: swapParams } }, async (req, reply) => {
    if (await refuse(req, reply)) return reply;
    return { pods: podList(await loadSwap(req.params.swapId, { pods: true })) };
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
        tx.create(col.pods.doc(podId), { SwapId: swapId, PodId: podId, Name: name, CreatedAt: now() });
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
        tx.update(col.pods.doc(podId), { Name: name });
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
        const members = rows<MemberDoc>(await tx.get(participantsQuery(swapId).where('PodId', '==', podId)));
        for (const m of members) tx.update(memberRef(swapId, m.UserId), { PodId: null });
        tx.delete(col.pods.doc(podId));
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
          tx.update(memberRef(swapId, userId), { PodId: podId === DEFAULT_POD ? null : podId });
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
        const data = await loadSwap(swapId, { people: true, pods: true }, tx);
        const pods = podList(data);
        const pod = pods.find((p) => p.podId === podId);
        if (!pod) throw new Problem('That pod was not found.', 404);
        const inPod = data.members.filter((r) => matches(r, { pod: podId }, []));
        if (inPod.length <= size) {
          throw new Problem(`This pod has ${inPod.length} ${inPod.length === 1 ? 'person' : 'people'}, so it's already that size or smaller.`);
        }
        const plan = planSplit(
          inPod.map((r) => ({
            userId: r.UserId,
            skillLevel: r.member.SkillLevel ?? null,
            country: r.profile?.Country ?? null,
            region: r.profile?.Region ?? null,
            postalCode: r.profile?.PostalCode ?? null,
          })),
          size,
          pod.name,
          pods.filter((p) => p.podId !== podId).map((p) => p.name),
        );
        const made = plan.map((p) => ({ podId: randomUUID(), name: p.name, count: p.userIds.length, userIds: p.userIds }));
        for (const p of made) {
          tx.create(col.pods.doc(p.podId), { SwapId: swapId, PodId: p.podId, Name: p.name, CreatedAt: now() });
          for (const userId of p.userIds) tx.update(memberRef(swapId, userId), { PodId: p.podId });
        }
        // The old pod is empty now. Default always stays.
        if (podId !== DEFAULT_POD) tx.delete(col.pods.doc(podId));
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
        const data = await loadSwap(swapId, { people: true, assignments: true }, tx);
        const inPod = data.members.filter((r) => matches(r, { pod: podId }, []));
        const edges = data.assignments.map((a) => ({ makerId: a.MakerId, recipientId: a.RecipientId }));
        const plan = planLoop(inPod.map((r) => r.UserId), edges);
        for (const e of plan.add) {
          tx.create(col.assignments.doc(assignmentId(swapId, e.makerId, e.recipientId)), newAssignment(swapId, e.makerId, e.recipientId, userId));
        }
        const name = new Map(inPod.map((r) => [r.UserId, r.name]));
        const problems = [
          ...plan.unmatchedMakers.map((id) => `${name.get(id)} isn't making for anyone yet.`),
          ...plan.unmatchedRecipients.map((id) => `Nobody is making for ${name.get(id)} yet.`),
        ];
        if (inPod.length < 2 && problems.length) problems.unshift('A pod needs at least 2 people to make a loop.');
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
        const current = rows<AssignmentDoc>(
          await tx.get(col.assignments.where('SwapId', '==', swapId).where('MakerId', '==', makerId)),
        );
        const recipients = current.map((r) => r.RecipientId);
        if (recipients.includes(recipientId)) return 'existing' as const;
        if (recipients.length >= MAX_RECIPIENTS) {
          const maker = (await lookupPeople([makerId], tx)).get(makerId)!;
          throw new Problem(`${maker.name} already makes for ${MAX_RECIPIENTS} people.`);
        }
        tx.create(col.assignments.doc(assignmentId(swapId, makerId, recipientId)), newAssignment(swapId, makerId, recipientId, userId));
        return 'added' as const;
      });
      if (!done) return reply;
      // Once makers are published, a new pairing needs confirming like the rest, so tell the maker.
      const swap = (await getSwap(swapId))!;
      if (done === 'added' && swap.makersPublishedAt) {
        const maker = await col.users.doc(makerId).get();
        const email = (maker.data() as UserDoc | undefined)?.Email;
        try {
          if (email) await sendUserMail({ userId: makerId, email }, 'new_pairing', swapId, newPairingEmail(swap, config.appBaseUrl));
        } catch (err) {
          req.log.error({ err, makerId }, 'Could not send new pairing email');
        }
      }
      return { assigned: true };
    },
  );

  app.delete<{ Params: { swapId: string; makerId: string; recipientId: string } }>(
    '/api/swaps/:swapId/assignments/:makerId/:recipientId',
    { ...auth, schema: { params: withParams('makerId', 'recipientId') } },
    async (req, reply) => {
      if (await refuse(req, reply)) return reply;
      const { swapId, makerId, recipientId } = req.params;
      await col.assignments.doc(assignmentId(swapId, makerId, recipientId)).delete();
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
      const { rows: list, data } = await queryMembers(swapId, {}, { limit: 100_000 }, { pods: true, assignments: true });
      const pairs = await pairingsFor(data, list.map((r) => r.UserId));
      const label = (p: Shown) => (p.instagramHandle ? `${p.name} (@${p.instagramHandle})` : p.name);
      const members = list
        .map((r) => toMember(r, data, pairs))
        .sort(
          (a, b) =>
            Number(a.pod.podId !== DEFAULT_POD) - Number(b.pod.podId !== DEFAULT_POD) ||
            a.pod.name.localeCompare(b.pod.name, undefined, { numeric: true }) ||
            a.name.localeCompare(b.name),
        );
      const byId = new Map(list.map((r) => [r.UserId, r]));
      const csv = toCsv([
        [
          'Name', 'Email', 'Instagram', 'Instagram link', 'Instagram confirmed', 'Name on package',
          'Address line 1', 'Address line 2', 'City', 'State/Region', 'Postal code', 'Country',
          'Pod', 'Skill level',
          // Each person they make for, then whether the maker has confirmed and shipped that one.
          ...Array.from({ length: MAX_RECIPIENTS }, (_, i) => {
            const make = i === 0 ? 'Make' : `Make ${i + 1}`;
            return [i === 0 ? 'Making For' : `Making For ${i + 1}`, `${make} Confirmed`, `${make} Shipped`, `${make} Tracking`, `${make} Tracking link`];
          }).flat(),
          'Made by',
        ],
        ...members.map((m) => {
          const p = byId.get(m.userId)!.profile;
          return [
            m.name,
            m.email,
            m.instagramHandle ? `@${m.instagramHandle}` : '',
            m.instagramHandle ? `https://www.instagram.com/${m.instagramHandle}/` : '',
            m.instagramConfirmed ? 'Yes' : 'No',
            p?.RecipientName ?? null,
            p?.AddressLine1 ?? null,
            p?.AddressLine2 ?? null,
            p?.City ?? null,
            p?.Region ?? null,
            p?.PostalCode ?? null,
            p?.Country ?? null,
            m.pod.name,
            m.skillLevel,
            ...Array.from({ length: MAX_RECIPIENTS }, (_, i) => {
              const made = m.makingFor[i];
              if (!made) return ['', '', '', '', ''];
              const s = made.shipped;
              return [
                label(made),
                made.confirmed ? 'Yes' : 'No',
                s ? 'Yes' : 'No',
                s ? `${s.carrier === 'other' ? '' : `${carrierLabel(s.carrier)} `}${s.trackingNumber}` : '',
                s?.trackingUrl ?? '',
              ];
            }).flat(),
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

/** A new, unconfirmed and unshipped pairing. */
function newAssignment(swapId: string, makerId: string, recipientId: string, createdBy: string) {
  return {
    SwapId: swapId,
    MakerId: makerId,
    RecipientId: recipientId,
    CreatedBy: createdBy,
    CreatedAt: now(),
    ConfirmedAt: null,
    ShippedAt: null,
    Carrier: null,
    TrackingNumber: null,
  };
}
