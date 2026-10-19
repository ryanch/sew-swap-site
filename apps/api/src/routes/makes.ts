import { Spanner } from '@google-cloud/spanner';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/plugin';
import { config } from '../config';
import { database } from '../db/spanner';
import { sendToMany, sendUserMail, type Recipient } from '../email/mailer';
import { makersPublishedEmail, packageShippedEmail, reminderEmail, shipReminderEmail } from '../email/templates';
import { CARRIER_IDS, carrierLabel, normalizeTracking, toShipment, trackingUrl } from '../shipping/tracking';
import { getSwap, swapParamsSchema } from '../swaps/access';
import { countMembers, NAME_SQL, refuse } from './pods';

// Publishing makers and confirming them. Until the manager publishes, pairings stay the manager's
// private view (routes/pods.ts). After that, each maker sees who they make for and confirms.

/** A batch of reminders. The manager works through a big swap a batch at a time. */
export const MAX_REMINDERS_PER_BATCH = 50;

/** Someone reminded this recently isn't reminded again. */
const REMINDER_GAP_HOURS = 24;

type MakeRow = {
  SwapId: string;
  Title: string;
  ShipBy: string;
  RecipientId: string;
  Name: string;
  InstagramHandle: string | null;
  RecipientName: string | null;
  AddressLine1: string | null;
  AddressLine2: string | null;
  City: string | null;
  Region: string | null;
  PostalCode: string | null;
  Country: string | null;
  ConfirmedAt: string | null;
  ShippedAt: string | null;
  Carrier: string | null;
  TrackingNumber: string | null;
};

type ConfirmBody = { seenInstagram?: boolean; reviewedAddress?: boolean; canShip?: boolean };
type ShipBody = { carrier: string; trackingNumber: string };

/** What each kind of reminder is for: who still needs one, and the email it sends. */
const REMINDERS = {
  confirm: { kind: 'confirm_reminder', pending: 'a.ConfirmedAt IS NULL', email: reminderEmail },
  ship: { kind: 'ship_reminder', pending: 'a.ShippedAt IS NULL', email: shipReminderEmail },
} as const;

/** Where the manager stands: how many are paired, and how many makers have confirmed. */
async function publishSummary(swapId: string) {
  const [[pairs], participants, withoutRecipient, withoutMaker] = await Promise.all([
    database.run({
      sql: `SELECT COUNT(*) AS Pairings, COUNTIF(ConfirmedAt IS NOT NULL) AS PairingsConfirmed,
                   COUNTIF(ShippedAt IS NOT NULL) AS PairingsShipped,
                   COUNT(DISTINCT MakerId) AS Makers,
                   COUNT(DISTINCT IF(ConfirmedAt IS NULL, MakerId, NULL)) AS MakersPending,
                   COUNT(DISTINCT IF(ShippedAt IS NULL, MakerId, NULL)) AS MakersUnshipped
            FROM Assignments WHERE SwapId = @swapId`,
      params: { swapId },
      json: true,
    }),
    countMembers(database, swapId, {}),
    countMembers(database, swapId, { needs: 'recipient' }),
    countMembers(database, swapId, { needs: 'maker' }),
  ]);
  const p = pairs[0] as {
    Pairings: number;
    PairingsConfirmed: number;
    PairingsShipped: number;
    Makers: number;
    MakersPending: number;
    MakersUnshipped: number;
  };
  return {
    participants,
    withoutRecipient,
    withoutMaker,
    pairings: Number(p.Pairings),
    pairingsConfirmed: Number(p.PairingsConfirmed),
    makers: Number(p.Makers),
    makersConfirmed: Number(p.Makers) - Number(p.MakersPending),
    pairingsShipped: Number(p.PairingsShipped),
    // Makers who have shipped to everyone they make for.
    makersShipped: Number(p.Makers) - Number(p.MakersUnshipped),
  };
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
      const published = await database.runTransactionAsync(async (tx) => {
        const [rows] = await tx.run({
          sql: `SELECT MakersPublishedAt IS NOT NULL AS Published FROM Swaps WHERE SwapId = @swapId`,
          params: { swapId },
          json: true,
        });
        if ((rows[0] as { Published: boolean }).Published) {
          await tx.rollback();
          return false;
        }
        tx.update('Swaps', { SwapId: swapId, MakersPublishedAt: Spanner.COMMIT_TIMESTAMP, MakersPublishedBy: req.user!.userId });
        await tx.commit();
        return true;
      });
      if (!published) return reply.code(409).send({ error: 'Makers for this swap are already published.' });

      const swap = (await getSwap(swapId))!;
      const [rows] = await database.run({
        sql: `SELECT DISTINCT a.MakerId AS UserId, u.Email FROM Assignments a JOIN Users u ON u.UserId = a.MakerId
              WHERE a.SwapId = @swapId`,
        params: { swapId },
        json: true,
      });
      const makers = (rows as { UserId: string; Email: string }[]).map((r) => ({ userId: r.UserId, email: r.Email }));
      const email = makersPublishedEmail(swap, config.appBaseUrl);
      const { sent, failed } = await sendToMany(makers, (m) => sendUserMail(m, 'makers_published', swapId, email), req.log);
      return { publishedAt: swap.makersPublishedAt, emailed: sent, failed };
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
      const [rows] = await database.run({
        sql: `SELECT DISTINCT a.MakerId AS UserId, u.Email,
                     EXISTS (SELECT 1 FROM EmailLog e
                             WHERE e.SwapId = a.SwapId AND e.Kind = @kind AND e.UserId = a.MakerId
                               AND e.Status IN ('sent', 'sending')
                               AND e.SentAt > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${REMINDER_GAP_HOURS} HOUR)) AS Recent
              FROM Assignments a JOIN Users u ON u.UserId = a.MakerId
              WHERE a.SwapId = @swapId AND a.MakerId IN UNNEST(@ids) AND ${reminder.pending}`,
        params: { swapId, ids, kind: reminder.kind },
        json: true,
      });
      const pending = rows as { UserId: string; Email: string; Recent: boolean }[];
      const due: Recipient[] = pending.filter((r) => !r.Recent).map((r) => ({ userId: r.UserId, email: r.Email }));
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
    const [rows] = await database.run({
      sql: `SELECT a.SwapId, s.Title, FORMAT_DATE('%F', s.ShipBy) AS ShipBy, a.RecipientId, ${NAME_SQL} AS Name,
                   p.InstagramHandle, p.RecipientName, p.AddressLine1, p.AddressLine2, p.City, p.Region, p.PostalCode, p.Country,
                   FORMAT_TIMESTAMP('%FT%TZ', a.ConfirmedAt) AS ConfirmedAt,
                   FORMAT_TIMESTAMP('%FT%TZ', a.ShippedAt) AS ShippedAt, a.Carrier, a.TrackingNumber
            FROM Assignments a
            JOIN Swaps s ON s.SwapId = a.SwapId
            JOIN Users u ON u.UserId = a.RecipientId
            LEFT JOIN UserProfiles p ON p.UserId = a.RecipientId
            WHERE a.MakerId = @userId AND s.MakersPublishedAt IS NOT NULL
            ORDER BY s.ShipBy, s.Title, Name`,
      params: { userId: req.user!.userId },
      json: true,
    });
    return {
      makes: (rows as MakeRow[]).map((r) => ({
        swap: { swapId: r.SwapId, title: r.Title, shipBy: r.ShipBy },
        recipient: {
          userId: r.RecipientId,
          name: r.Name,
          instagramHandle: r.InstagramHandle,
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
        confirmedAt: r.ConfirmedAt,
        shipped: toShipment(r),
      })),
    };
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
      const confirmedAt = await database.runTransactionAsync(async (tx) => {
        const [rows] = await tx.run({
          sql: `SELECT FORMAT_TIMESTAMP('%FT%TZ', a.ConfirmedAt) AS ConfirmedAt FROM Assignments a
                JOIN Swaps s ON s.SwapId = a.SwapId
                WHERE a.SwapId = @swapId AND a.MakerId = @makerId AND a.RecipientId = @recipientId
                  AND s.MakersPublishedAt IS NOT NULL`,
          params: { swapId, makerId, recipientId },
          json: true,
        });
        const row = rows[0] as { ConfirmedAt: string | null } | undefined;
        if (!row || row.ConfirmedAt) {
          await tx.rollback();
          return row ? row.ConfirmedAt : undefined;
        }
        const b = req.body ?? {};
        if (!(b.seenInstagram && b.reviewedAddress && b.canShip)) {
          await tx.rollback();
          return null;
        }
        tx.update('Assignments', { SwapId: swapId, MakerId: makerId, RecipientId: recipientId, ConfirmedAt: Spanner.COMMIT_TIMESTAMP });
        await tx.commit();
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
      const result = await database.runTransactionAsync(async (tx) => {
        const [rows] = await tx.run({
          sql: `SELECT a.ConfirmedAt IS NOT NULL AS Confirmed, a.Carrier, a.TrackingNumber FROM Assignments a
                JOIN Swaps s ON s.SwapId = a.SwapId
                WHERE a.SwapId = @swapId AND a.MakerId = @makerId AND a.RecipientId = @recipientId
                  AND s.MakersPublishedAt IS NOT NULL`,
          params: { swapId, makerId, recipientId },
          json: true,
        });
        const row = rows[0] as { Confirmed: boolean; Carrier: string | null; TrackingNumber: string | null } | undefined;
        const outcome = !row
          ? 'missing'
          : !row.Confirmed
            ? 'unconfirmed'
            : !trackingNumber
              ? 'invalid'
              : row.Carrier === req.body.carrier && row.TrackingNumber === trackingNumber
                ? 'unchanged'
                : 'shipped';
        if (outcome !== 'shipped') {
          await tx.rollback();
          return outcome;
        }
        tx.update('Assignments', {
          SwapId: swapId,
          MakerId: makerId,
          RecipientId: recipientId,
          ShippedAt: Spanner.COMMIT_TIMESTAMP,
          Carrier: req.body.carrier,
          TrackingNumber: trackingNumber,
        });
        await tx.commit();
        return outcome;
      });
      if (result === 'missing') return reply.code(404).send({ error: "You aren't making for this person." });
      if (result === 'unconfirmed') return reply.code(409).send({ error: 'Please confirm who you are making for first.' });
      if (result === 'invalid') {
        return reply.code(400).send({ error: 'Please enter the tracking number from your shipping receipt, and pick the carrier.' });
      }
      if (result === 'shipped') {
        const [swap, [users]] = await Promise.all([
          getSwap(swapId),
          database.run({ sql: 'SELECT Email FROM Users WHERE UserId = @recipientId', params: { recipientId }, json: true }),
        ]);
        const to = users[0] as { Email: string } | undefined;
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
    const [rows] = await database.run({
      sql: `SELECT EmailId, FORMAT_TIMESTAMP('%FT%TZ', SentAt) AS SentAt, Kind, SwapId, Subject, Body
            FROM EmailLog WHERE UserId = @userId AND Status = 'sent' ORDER BY SentAt DESC LIMIT 100`,
      params: { userId: req.user!.userId },
      json: true,
    });
    return {
      emails: (rows as { EmailId: string; SentAt: string; Kind: string; SwapId: string | null; Subject: string; Body: string }[]).map(
        (r) => ({ emailId: r.EmailId, sentAt: r.SentAt, kind: r.Kind, swapId: r.SwapId, subject: r.Subject, body: r.Body }),
      ),
    };
  });
}
