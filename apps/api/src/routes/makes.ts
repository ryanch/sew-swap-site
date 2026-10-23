import type { Timestamp } from '@google-cloud/firestore';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/plugin';
import { config } from '../config';
import { assignmentId, col, db, getMany, inTransaction, now, Problem, rows, toIso } from '../db/firestore';
import { loadPeople, personName, type UserDoc } from '../db/people';
import { sendToMany, sendUserMail, type EmailLogDoc, type Recipient } from '../email/mailer';
import { makersPublishedEmail, packageShippedEmail, reminderEmail, shipReminderEmail } from '../email/templates';
import { CARRIER_IDS, carrierLabel, normalizeTracking, toShipment, trackingUrl } from '../shipping/tracking';
import { getSwap, swapParamsSchema, type SwapDoc } from '../swaps/access';
import { countMembers, refuse } from './pods';
import { addressView } from './profile';

// Publishing makers and confirming them. Until the manager publishes, pairings stay the manager's
// private view (routes/pods.ts). After that, each maker sees who they make for and confirms.

/** A batch of reminders. The manager works through a big swap a batch at a time. */
export const MAX_REMINDERS_PER_BATCH = 50;

/** Someone reminded this recently isn't reminded again. */
const REMINDER_GAP_HOURS = 24;

/** The `assignments` doc: maker makes for recipient. */
type AssignmentDoc = {
  SwapId: string;
  MakerId: string;
  RecipientId: string;
  ConfirmedAt?: Timestamp | null;
  ShippedAt?: Timestamp | null;
  Carrier?: string | null;
  TrackingNumber?: string | null;
};

const shipment = (a: AssignmentDoc) =>
  toShipment({ ShippedAt: toIso(a.ShippedAt), Carrier: a.Carrier ?? null, TrackingNumber: a.TrackingNumber ?? null });

/** Earlier Timestamps first, to the nanosecond, so things done in the same second keep their order. */
const byTime = (a: Timestamp, b: Timestamp) => a.seconds - b.seconds || a.nanoseconds - b.nanoseconds;

const pairingsOf = async (swapId: string) => rows<AssignmentDoc>(await col.assignments.where('SwapId', '==', swapId).get());

type ConfirmBody = { seenInstagram?: boolean; reviewedAddress?: boolean; canShip?: boolean };
type ShipBody = { carrier: string; trackingNumber: string };

/** What each kind of reminder is for: who still needs one, and the email it sends. */
const REMINDERS = {
  confirm: { kind: 'confirm_reminder', pending: (a: AssignmentDoc) => !a.ConfirmedAt, email: reminderEmail },
  ship: { kind: 'ship_reminder', pending: (a: AssignmentDoc) => !a.ShippedAt, email: shipReminderEmail },
} as const;

/** Where the manager stands: how many are paired, and how many makers have confirmed. */
async function publishSummary(swapId: string) {
  const [pairs, participants, withoutRecipient, withoutMaker] = await Promise.all([
    pairingsOf(swapId),
    countMembers(swapId, {}),
    countMembers(swapId, { needs: 'recipient' }),
    countMembers(swapId, { needs: 'maker' }),
  ]);
  const makers = new Set(pairs.map((a) => a.MakerId));
  const makersPending = new Set(pairs.filter((a) => !a.ConfirmedAt).map((a) => a.MakerId));
  const makersUnshipped = new Set(pairs.filter((a) => !a.ShippedAt).map((a) => a.MakerId));
  return {
    participants,
    withoutRecipient,
    withoutMaker,
    pairings: pairs.length,
    pairingsConfirmed: pairs.filter((a) => a.ConfirmedAt).length,
    makers: makers.size,
    makersConfirmed: makers.size - makersPending.size,
    pairingsShipped: pairs.filter((a) => a.ShippedAt).length,
    // Makers who have shipped to everyone they make for.
    makersShipped: makers.size - makersUnshipped.size,
  };
}

/** Email addresses of `userIds`. Anyone without a user doc is left out. */
async function recipients(userIds: string[]): Promise<Recipient[]> {
  const users = await getMany<UserDoc>(col.users, userIds);
  return [...new Set(userIds)].filter((id) => users.has(id)).map((id) => ({ userId: id, email: users.get(id)!.Email }));
}

export async function makeRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireAuth };

  app.get<{ Params: { swapId: string } }>(
    '/api/swaps/:swapId/publish',
    { ...auth, schema: { params: swapParamsSchema } },
    async (req, reply) => {
      if (await refuse(req, reply)) return reply;
      const swap = (await getSwap(req.params.swapId))!;
      return {
        publishedAt: swap.makersPublishedAt,
        partnersAnnounced: swap.partnersAnnounced,
        ...(await publishSummary(swap.swapId)),
      };
    },
  );

  // Publishing is the manager's call ("Partners announced" is only a guide), and it emails every maker.
  // It's allowed with people left unpaired; the page warns about them first.
  app.post<{ Params: { swapId: string }; Body: { confirm: true } }>(
    '/api/swaps/:swapId/publish',
    {
      ...auth,
      schema: {
        params: swapParamsSchema,
        body: {
          type: 'object',
          required: ['confirm'],
          additionalProperties: false,
          properties: { confirm: { const: true } },
        },
      },
    },
    async (req, reply) => {
      if (await refuse(req, reply)) return reply;
      const { swapId } = req.params;
      const published = await inTransaction(reply, async (tx) => {
        const ref = col.swaps.doc(swapId);
        const swap = (await tx.get(ref)).data() as SwapDoc;
        if (swap.MakersPublishedAt) throw new Problem('Makers for this swap are already published.', 409);
        tx.update(ref, { MakersPublishedAt: now(), MakersPublishedBy: req.user!.userId });
        return true;
      });
      if (!published) return reply;

      const [swap, pairs] = await Promise.all([getSwap(swapId), pairingsOf(swapId)]);
      const makers = await recipients(pairs.map((a) => a.MakerId));
      const email = makersPublishedEmail(swap!, config.appBaseUrl);
      const { sent, failed } = await sendToMany(makers, (m) => sendUserMail(m, 'makers_published', swapId, email), req.log);
      return { publishedAt: swap!.makersPublishedAt, emailed: sent, failed };
    },
  );

  // Reminds makers who still have someone to confirm (`kind: 'confirm'`, the default) or a package
  // to ship (`kind: 'ship'`). Skips anyone sent the same reminder in the last day, so sending the
  // same batch twice doesn't email people twice. The manager decides when; nothing waits for ShipBy.
  app.post<{ Params: { swapId: string }; Body: { userIds: string[]; kind?: keyof typeof REMINDERS } }>(
    '/api/swaps/:swapId/reminders',
    {
      ...auth,
      schema: {
        params: swapParamsSchema,
        body: {
          type: 'object',
          required: ['userIds'],
          additionalProperties: false,
          properties: {
            userIds: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_REMINDERS_PER_BATCH,
              items: { type: 'string', maxLength: 36 },
            },
            kind: { type: 'string', enum: Object.keys(REMINDERS) },
          },
        },
      },
    },
    async (req, reply) => {
      if (await refuse(req, reply)) return reply;
      const { swapId } = req.params;
      const swap = (await getSwap(swapId))!;
      if (!swap.makersPublishedAt) return reply.code(409).send({ error: 'Publish makers before sending reminders.' });
      const ids = [...new Set(req.body.userIds)];
      const kind = req.body.kind ?? 'confirm';
      const reminder = REMINDERS[kind];
      const wanted = new Set(ids);
      const [pairs, log] = await Promise.all([
        pairingsOf(swapId),
        col.emailLog.where('SwapId', '==', swapId).where('Kind', '==', reminder.kind).get(),
      ]);
      const pending = await recipients(pairs.filter((a) => wanted.has(a.MakerId) && reminder.pending(a)).map((a) => a.MakerId));
      const since = Date.now() - REMINDER_GAP_HOURS * 60 * 60 * 1000;
      const recent = new Set(
        rows<EmailLogDoc>(log)
          .filter((e) => (e.Status === 'sent' || e.Status === 'sending') && e.SentAt.toMillis() > since)
          .map((e) => e.UserId),
      );
      const due = pending.filter((r) => !recent.has(r.userId));
      const email = reminder.email(swap, config.appBaseUrl);
      const { sent, failed } = await sendToMany(due, (m) => sendUserMail(m, reminder.kind, swapId, email), req.log);
      const skippedDone = ids.length - pending.length;
      return {
        sent,
        failed,
        skippedRecent: pending.length - due.length,
        ...(kind === 'ship' ? { skippedShipped: skippedDone } : { skippedConfirmed: skippedDone }),
      };
    },
  );

  // Who the caller makes for, in swaps whose makers are published. Nothing shows before that.
  app.get('/api/me/makes', auth, async (req) => {
    const mine = rows<AssignmentDoc>(await col.assignments.where('MakerId', '==', req.user!.userId).get());
    const [swaps, { users, profiles }] = await Promise.all([
      getMany<SwapDoc>(col.swaps, mine.map((a) => a.SwapId)),
      loadPeople(mine.map((a) => a.RecipientId)),
    ]);
    const makes = mine
      .filter((a) => swaps.get(a.SwapId)?.MakersPublishedAt && users.has(a.RecipientId))
      .map((a) => {
        const s = swaps.get(a.SwapId)!;
        const p = profiles.get(a.RecipientId);
        return {
          swap: { swapId: a.SwapId, title: s.Title, shipBy: s.ShipBy },
          recipient: {
            userId: a.RecipientId,
            name: personName(users.get(a.RecipientId)!, p),
            instagramHandle: p?.InstagramHandle ?? null,
            address: p?.Country ? addressView(p) : null,
          },
          confirmedAt: toIso(a.ConfirmedAt),
          shipped: shipment(a),
        };
      });
    const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
    makes.sort(
      (x, y) => cmp(x.swap.shipBy, y.swap.shipBy) || cmp(x.swap.title, y.swap.title) || cmp(x.recipient.name, y.recipient.name),
    );
    return { makes };
  });

  // The maker ticks three boxes on the page; they're checked here too.
  app.post<{ Params: { swapId: string; recipientId: string }; Body: ConfirmBody }>(
    '/api/swaps/:swapId/makes/:recipientId/confirm',
    {
      ...auth,
      schema: {
        params: {
          type: 'object',
          required: ['swapId', 'recipientId'],
          properties: { swapId: { type: 'string', maxLength: 36 }, recipientId: { type: 'string', maxLength: 36 } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { seenInstagram: { type: 'boolean' }, reviewedAddress: { type: 'boolean' }, canShip: { type: 'boolean' } },
        },
      },
    },
    async (req, reply) => {
      const { swapId, recipientId } = req.params;
      const makerId = req.user!.userId;
      const ref = col.assignments.doc(assignmentId(swapId, makerId, recipientId));
      const confirmedAt = await db.runTransaction(async (tx) => {
        const [pair, swap] = await tx.getAll(ref, col.swaps.doc(swapId));
        if (!pair.exists || !(swap.data() as SwapDoc | undefined)?.MakersPublishedAt) return undefined;
        const done = (pair.data() as AssignmentDoc).ConfirmedAt;
        if (done) return toIso(done);
        const b = req.body ?? {};
        if (!(b.seenInstagram && b.reviewedAddress && b.canShip)) return null;
        tx.update(ref, { ConfirmedAt: now() });
        return 'now';
      });
      // Missing and not-yet-published look the same, so nothing leaks before publishing.
      if (confirmedAt === undefined) return reply.code(404).send({ error: "You aren't making for this person." });
      if (confirmedAt === null) return reply.code(400).send({ error: 'Please tick all three boxes to confirm.' });
      return { confirmed: true };
    },
  );

  // The maker says they shipped, with the carrier and tracking number. Only after confirming.
  // Sending it again with a new number corrects it. The recipient is emailed the tracking, without
  // the maker's name.
  app.post<{ Params: { swapId: string; recipientId: string }; Body: ShipBody }>(
    '/api/swaps/:swapId/makes/:recipientId/ship',
    {
      ...auth,
      schema: {
        params: {
          type: 'object',
          required: ['swapId', 'recipientId'],
          properties: { swapId: { type: 'string', maxLength: 36 }, recipientId: { type: 'string', maxLength: 36 } },
        },
        body: {
          type: 'object',
          required: ['carrier', 'trackingNumber'],
          additionalProperties: false,
          properties: { carrier: { type: 'string', enum: CARRIER_IDS }, trackingNumber: { type: 'string', maxLength: 100 } },
        },
      },
      // A missing pairing answers 404 whatever was sent, like /confirm.
      attachValidation: true,
    },
    async (req, reply) => {
      const { swapId, recipientId } = req.params;
      const makerId = req.user!.userId;
      const trackingNumber = req.validationError ? null : normalizeTracking(req.body.trackingNumber);
      const ref = col.assignments.doc(assignmentId(swapId, makerId, recipientId));
      const result = await db.runTransaction(async (tx) => {
        const [pair, swap] = await tx.getAll(ref, col.swaps.doc(swapId));
        const row = pair.exists && (swap.data() as SwapDoc | undefined)?.MakersPublishedAt ? (pair.data() as AssignmentDoc) : undefined;
        const outcome = !row
          ? 'missing'
          : !row.ConfirmedAt
            ? 'unconfirmed'
            : !trackingNumber
              ? 'invalid'
              : row.Carrier === req.body.carrier && row.TrackingNumber === trackingNumber
                ? 'unchanged'
                : 'shipped';
        if (outcome === 'shipped') tx.update(ref, { ShippedAt: now(), Carrier: req.body.carrier, TrackingNumber: trackingNumber });
        return outcome;
      });
      if (result === 'missing') return reply.code(404).send({ error: "You aren't making for this person." });
      if (result === 'unconfirmed') return reply.code(409).send({ error: 'Please confirm who you are making for first.' });
      if (result === 'invalid') {
        return reply.code(400).send({ error: 'Please enter the tracking number from your shipping receipt, and pick the carrier.' });
      }
      if (result === 'shipped') {
        const [swap, user] = await Promise.all([getSwap(swapId), col.users.doc(recipientId).get()]);
        const to = user.data() as UserDoc | undefined;
        const { carrier } = req.body;
        const email = packageShippedEmail(
          swap!,
          { carrier: carrier === 'other' ? null : carrierLabel(carrier), trackingNumber: trackingNumber!, trackingUrl: trackingUrl(carrier, trackingNumber!) },
          config.appBaseUrl,
        );
        if (to) {
          await sendUserMail({ userId: recipientId, email: to.Email }, 'package_shipped', swapId, email).catch((err) =>
            req.log.error({ err, userId: recipientId }, 'Could not send email'),
          );
        }
      }
      return { shipped: true, trackingNumber };
    },
  );

  app.get('/api/me/emails', auth, async (req) => {
    const log = rows<EmailLogDoc>(await col.emailLog.where('UserId', '==', req.user!.userId).get());
    const sent = log
      .filter((e) => e.Status === 'sent')
      .sort((a, b) => byTime(b.SentAt, a.SentAt))
      .slice(0, 100);
    return {
      emails: sent.map((e) => ({
        emailId: e.EmailId,
        sentAt: toIso(e.SentAt),
        kind: e.Kind,
        swapId: e.SwapId,
        subject: e.Subject,
        body: e.Body,
      })),
    };
  });
}
