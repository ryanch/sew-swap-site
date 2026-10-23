import { randomUUID } from 'node:crypto';
import type { Timestamp } from '@google-cloud/firestore';
import type { FastifyInstance } from 'fastify';
import type { AuthUser } from '../auth/users';
import { requireAuth } from '../auth/plugin';
import { hasRole, requireRole } from '../auth/roles';
import { config } from '../config';
import { col, db, getMany, inTransaction, memberId, now, Problem, rows, todayUtc, toIso } from '../db/firestore';
import type { ProfileDoc } from '../db/people';
import { validateAddress } from '../profile/address';
import { toShipment, type Shipment } from '../shipping/tracking';
import { bySignUpOpens, canManage, getSwap, swapParamsSchema, toSwap, type SwapDoc } from '../swaps/access';
import { addressColumns } from './profile';

type JoinBody = { address?: unknown; instagramPublicConfirmed?: boolean } | undefined;

type SwapBody = {
  title: string;
  description?: string;
  makingDeadline: string;
  partnersAnnounced: string;
  shipBy: string;
  signUpOpens: string;
  signUpCloses: string;
};

const dateField = { type: 'string', format: 'date' } as const;
const swapBodySchema = {
  type: 'object',
  required: ['title', 'makingDeadline', 'partnersAnnounced', 'shipBy', 'signUpOpens', 'signUpCloses'],
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', maxLength: 5000 },
    makingDeadline: dateField,
    partnersAnnounced: dateField,
    shipBy: dateField,
    signUpOpens: dateField,
    signUpCloses: dateField,
  },
} as const;

/** Returns an error message, or null when the swap is fine. ISO dates compare correctly as strings. */
function validate(body: SwapBody): string | null {
  if (!body.title.trim()) return 'Please give the swap a title.';
  if (body.signUpCloses < body.signUpOpens) return 'Sign-up must close on or after the day it opens.';
  return null;
}

function columns(body: SwapBody) {
  return {
    Title: body.title.trim(),
    Description: (body.description ?? '').trim(),
    MakingDeadline: body.makingDeadline,
    PartnersAnnounced: body.partnersAnnounced,
    ShipBy: body.shipBy,
    SignUpOpens: body.signUpOpens,
    SignUpCloses: body.signUpCloses,
  };
}

type MemberDoc = { SwapId: string; UserId: string; Role: string; CreatedAt: Timestamp };
type PackageDoc = { MakerId: string; RecipientId: string; ShippedAt: Timestamp | null; Carrier: string | null; TrackingNumber: string | null };

/** Swaps the caller is a manager of (every swap, for admins: `null`). */
async function managedSwapIds(user: AuthUser): Promise<Set<string> | null> {
  if (hasRole(user, 'admin')) return null;
  const snap = await col.swapMembers.where('UserId', '==', user.userId).where('Role', '==', 'manager').get();
  return new Set(rows<MemberDoc>(snap).map((m) => m.SwapId));
}

/** Sign-up numbers are only for the swap's managers and admins. */
async function toListedSwaps(swaps: SwapDoc[], managed: Set<string> | null) {
  const sorted = [...swaps].sort(bySignUpOpens);
  return Promise.all(
    sorted.map(async (s) => {
      if (managed && !managed.has(s.SwapId)) return toSwap(s);
      const count = await col.swapMembers.where('SwapId', '==', s.SwapId).where('Role', '==', 'participant').count().get();
      return { ...toSwap(s), swapperCount: count.data().count };
    }),
  );
}

/** 'upcoming', 'open' or 'closed', on today's UTC date. ISO dates compare correctly as strings. */
function signUpStatus(swap: { signUpOpens: string; signUpCloses: string }) {
  const today = todayUtc();
  if (today < swap.signUpOpens) return 'upcoming';
  if (today > swap.signUpCloses) return 'closed';
  return 'open';
}

export async function swapRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireAuth };
  const manager = { preHandler: requireRole('swap_manager') };

  app.get('/api/swaps', auth, async (req) => {
    const [swaps, managed] = await Promise.all([col.swaps.get(), managedSwapIds(req.user!)]);
    return { swaps: await toListedSwaps(rows<SwapDoc>(swaps), managed) };
  });

  // For the home page: swaps the caller joined as a participant, and swaps they own as a manager.
  app.get('/api/me/swaps', auth, async (req) => {
    const members = rows<MemberDoc>(await col.swapMembers.where('UserId', '==', req.user!.userId).get());
    const swaps = await getMany<SwapDoc>(col.swaps, members.map((m) => m.SwapId));
    const list = (role: string) =>
      members
        .filter((m) => m.Role === role && swaps.has(m.SwapId))
        .map((m) => swaps.get(m.SwapId)!)
        .sort(bySignUpOpens)
        .map(toSwap);
    return { joined: list('participant'), owned: list('manager') };
  });

  app.get('/api/swaps/mine', manager, async (req) => {
    const managed = await managedSwapIds(req.user!);
    const swaps = managed ? [...(await getMany<SwapDoc>(col.swaps, [...managed])).values()] : rows<SwapDoc>(await col.swaps.get());
    return { swaps: await toListedSwaps(swaps, managed) };
  });

  app.get<{ Params: { swapId: string } }>(
    '/api/swaps/:swapId',
    { ...auth, schema: { params: swapParamsSchema } },
    async (req, reply) => {
      const swap = await getSwap(req.params.swapId);
      if (!swap) return reply.code(404).send({ error: 'That swap was not found.' });
      const userId = req.user!.userId;
      const [membership, canEdit] = await Promise.all([
        col.swapMembers.doc(memberId(swap.swapId, userId, 'participant')).get(),
        canManage(req.user!, swap.swapId),
      ]);
      // Packages on their way to the caller. Only the tracking: who made it stays a surprise.
      let packages: Shipment[] = [];
      if (membership.exists && swap.makersPublishedAt) {
        const snap = await col.assignments.where('SwapId', '==', swap.swapId).where('RecipientId', '==', userId).get();
        packages = rows<PackageDoc>(snap)
          .filter((a) => a.ShippedAt)
          .sort((a, b) => a.ShippedAt!.toMillis() - b.ShippedAt!.toMillis())
          .map((a) => toShipment({ ...a, ShippedAt: toIso(a.ShippedAt) })!);
      }
      return {
        swap,
        canEdit,
        signUpStatus: signUpStatus(swap),
        membership: membership.exists ? { joinedAt: toIso((membership.data() as MemberDoc).CreatedAt), packages } : null,
      };
    },
  );

  // Joining and leaving act on the caller's own `participant` doc. Any signed-in user may join,
  // including the swap's managers: member docs are keyed by swap, user and role.
  // Joining needs a mailing address (saved to the profile) and a recent passing Instagram check
  // from POST /api/me/instagram/check. If that check couldn't confirm the account is public, the
  // person must say it is (`instagramPublicConfirmed`), and managers see it flagged.
  // The body is checked in the handler so a closed swap answers 403 whatever was sent.
  app.put<{ Params: { swapId: string }; Body: JoinBody }>(
    '/api/swaps/:swapId/membership',
    { ...auth, schema: { params: swapParamsSchema } },
    async (req, reply) => {
      const { swapId } = req.params;
      const userId = req.user!.userId;
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const memberRef = col.swapMembers.doc(memberId(swapId, userId, 'participant'));
      const profileRef = col.userProfiles.doc(userId);
      const joined = await inTransaction(reply, async (tx) => {
        const [swapSnap, profileSnap, existing] = await tx.getAll(col.swaps.doc(swapId), profileRef, memberRef);
        if (!swapSnap.exists) throw new Problem('That swap was not found.', 404);
        const swap = swapSnap.data() as SwapDoc;
        if (signUpStatus({ signUpOpens: swap.SignUpOpens, signUpCloses: swap.SignUpCloses }) !== 'open') {
          throw new Problem('Sign-up for this swap is not open.', 403);
        }
        const checked = validateAddress(body.address);
        if ('error' in checked) throw new Problem(checked.error);
        const profile = profileSnap.exists ? (profileSnap.data() as ProfileDoc) : null;
        if (!profile?.InstagramStatus) throw new Problem('Please check your Instagram before joining.');
        const freshSince = Date.now() - config.instagram.checkValidDays * 24 * 60 * 60 * 1000;
        if (!profile.InstagramCheckedAt || profile.InstagramCheckedAt.toMillis() <= freshSince) {
          throw new Problem('Please check your Instagram again before joining.');
        }
        const isPublic = profile.InstagramStatus === 'public';
        if (!isPublic && body.instagramPublicConfirmed !== true) {
          throw new Problem("We couldn't confirm your Instagram is public. Please tick the box to say it is.");
        }

        tx.set(profileRef, { UserId: userId, ...addressColumns(checked.address), UpdatedAt: now() }, { merge: true });
        const InstagramPublicConfirmed = isPublic ? null : true;
        if (existing.exists) {
          // Joining again keeps the original join time, skill and pod.
          tx.update(memberRef, { InstagramPublicConfirmed });
        } else {
          tx.create(memberRef, {
            SwapId: swapId,
            UserId: userId,
            Role: 'participant',
            InstagramPublicConfirmed,
            SkillLevel: null,
            PodId: null,
            CreatedAt: now(),
          });
        }
        return true;
      });
      if (!joined) return reply;
      return { joined: true };
    },
  );

  app.delete<{ Params: { swapId: string } }>(
    '/api/swaps/:swapId/membership',
    { ...auth, schema: { params: swapParamsSchema } },
    async (req, reply) => {
      const { swapId } = req.params;
      const userId = req.user!.userId;
      // Their pairings go too, so the manager sees who now needs a maker. Deleting a doc that
      // doesn't exist is a no-op, so leaving twice is fine.
      await db.runTransaction(async (tx) => {
        const inSwap = col.assignments.where('SwapId', '==', swapId);
        const [making, madeBy] = await Promise.all([
          tx.get(inSwap.where('MakerId', '==', userId)),
          tx.get(inSwap.where('RecipientId', '==', userId)),
        ]);
        for (const d of [...making.docs, ...madeBy.docs]) tx.delete(d.ref);
        tx.delete(col.swapMembers.doc(memberId(swapId, userId, 'participant')));
      });
      return reply.code(204).send();
    },
  );

  app.post<{ Body: SwapBody }>(
    '/api/swaps',
    { ...manager, schema: { body: swapBodySchema } },
    async (req, reply) => {
      const problem = validate(req.body);
      if (problem) return reply.code(400).send({ error: problem });
      const swapId = randomUUID();
      const userId = req.user!.userId;
      const at = now();
      const swap: SwapDoc = {
        SwapId: swapId,
        ...columns(req.body),
        MakersPublishedAt: null,
        MakersPublishedBy: null,
        CreatedBy: userId,
        CreatedAt: at,
        UpdatedAt: at,
      };
      await db
        .batch()
        .create(col.swaps.doc(swapId), swap)
        .create(col.swapMembers.doc(memberId(swapId, userId, 'manager')), { SwapId: swapId, UserId: userId, Role: 'manager', CreatedAt: at })
        .commit();
      return reply.code(201).send({ swap: toSwap(swap) });
    },
  );

  app.put<{ Params: { swapId: string }; Body: SwapBody }>(
    '/api/swaps/:swapId',
    { ...auth, schema: { params: swapParamsSchema, body: swapBodySchema } },
    async (req, reply) => {
      const { swapId } = req.params;
      if (!(await getSwap(swapId))) return reply.code(404).send({ error: 'That swap was not found.' });
      if (!(await canManage(req.user!, swapId))) {
        return reply.code(403).send({ error: "You can't change this swap." });
      }
      const problem = validate(req.body);
      if (problem) return reply.code(400).send({ error: problem });
      await col.swaps.doc(swapId).update({ ...columns(req.body), UpdatedAt: now() });
      return { swap: await getSwap(swapId) };
    },
  );
}
