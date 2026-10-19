import { randomUUID } from 'node:crypto';
import { Spanner } from '@google-cloud/spanner';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/plugin';
import { hasRole, requireRole } from '../auth/roles';
import { database } from '../db/spanner';
import { validateAddress } from '../profile/address';
import { toShipment, type Shipment } from '../shipping/tracking';
import { canManage, getSwap, SWAP_COLUMNS, swapParamsSchema, toSwap, type SwapRow } from '../swaps/access';
import { addressColumns, readProfile } from './profile';

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

// For swap lists: whether the caller manages each swap (@all for admins), and if so how many have signed up.
const MANAGED_SQL = `(@all OR EXISTS (SELECT 1 FROM SwapMembers mm
                                      WHERE mm.SwapId = s.SwapId AND mm.UserId = @userId AND mm.Role = 'manager'))`;
const LIST_COLUMNS = `${SWAP_COLUMNS}, ${MANAGED_SQL} AS Managed,
  (SELECT COUNT(*) FROM SwapMembers c WHERE c.SwapId = s.SwapId AND c.Role = 'participant') AS SwapperCount`;

type ListRow = SwapRow & { Managed: boolean; SwapperCount: number };

/** Sign-up numbers are only for the swap's managers and admins. */
const toListedSwap = (row: ListRow) => ({
  ...toSwap(row),
  ...(row.Managed ? { swapperCount: Number(row.SwapperCount) } : {}),
});

export async function swapRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireAuth };
  const manager = { preHandler: requireRole('swap_manager') };

  app.get('/api/swaps', auth, async (req) => {
    const [rows] = await database.run({
      sql: `SELECT ${LIST_COLUMNS} FROM Swaps s ORDER BY s.SignUpOpens DESC, s.Title`,
      params: { all: hasRole(req.user, 'admin'), userId: req.user!.userId },
      json: true,
    });
    return { swaps: (rows as ListRow[]).map(toListedSwap) };
  });

  // For the home page: swaps the caller joined as a participant, and swaps they own as a manager.
  app.get('/api/me/swaps', auth, async (req) => {
    const run = async (role: string) => {
      const [rows] = await database.run({
        sql: `SELECT ${SWAP_COLUMNS} FROM SwapMembers m JOIN Swaps s ON s.SwapId = m.SwapId
              WHERE m.UserId = @userId AND m.Role = @role
              ORDER BY s.SignUpOpens DESC, s.Title`,
        params: { userId: req.user!.userId, role },
        json: true,
      });
      return (rows as SwapRow[]).map(toSwap);
    };
    const [joined, owned] = await Promise.all([run('participant'), run('manager')]);
    return { joined, owned };
  });

  app.get('/api/swaps/mine', manager, async (req) => {
    const all = hasRole(req.user, 'admin');
    const [rows] = await database.run({
      sql: `SELECT ${LIST_COLUMNS} FROM Swaps s WHERE ${MANAGED_SQL} ORDER BY s.SignUpOpens DESC, s.Title`,
      params: { all, userId: req.user!.userId },
      json: true,
    });
    return { swaps: (rows as ListRow[]).map(toListedSwap) };
  });

  app.get<{ Params: { swapId: string } }>(
    '/api/swaps/:swapId',
    { ...auth, schema: { params: swapParamsSchema } },
    async (req, reply) => {
      const swap = await getSwap(req.params.swapId);
      if (!swap) return reply.code(404).send({ error: 'That swap was not found.' });
      const [[status], [membership], canEdit] = await Promise.all([
        database.run({
          sql: `SELECT CASE WHEN CURRENT_DATE() < SignUpOpens THEN 'upcoming'
                            WHEN CURRENT_DATE() > SignUpCloses THEN 'closed'
                            ELSE 'open' END AS Status
                FROM Swaps WHERE SwapId = @swapId`,
          params: { swapId: swap.swapId },
          json: true,
        }),
        database.run({
          sql: `SELECT FORMAT_TIMESTAMP('%FT%TZ', CreatedAt) AS JoinedAt FROM SwapMembers
                WHERE SwapId = @swapId AND UserId = @userId AND Role = 'participant'`,
          params: { swapId: swap.swapId, userId: req.user!.userId },
          json: true,
        }),
        canManage(req.user!, swap.swapId),
      ]);
      // Packages on their way to the caller. Only the tracking: who made it stays a surprise.
      let packages: Shipment[] = [];
      if (membership[0] && swap.makersPublishedAt) {
        const [rows] = await database.run({
          sql: `SELECT FORMAT_TIMESTAMP('%FT%TZ', ShippedAt) AS ShippedAt, Carrier, TrackingNumber FROM Assignments
                WHERE SwapId = @swapId AND RecipientId = @userId AND ShippedAt IS NOT NULL
                ORDER BY ShippedAt`,
          params: { swapId: swap.swapId, userId: req.user!.userId },
          json: true,
        });
        packages = (rows as { ShippedAt: string; Carrier: string; TrackingNumber: string }[]).map((r) => toShipment(r)!);
      }
      return {
        swap,
        canEdit,
        signUpStatus: (status[0] as { Status: string }).Status,
        membership: membership[0] ? { joinedAt: (membership[0] as { JoinedAt: string }).JoinedAt, packages } : null,
      };
    },
  );

  // Joining and leaving act on the caller's own `participant` row. Any signed-in user may join,
  // including the swap's managers: SwapMembers is keyed (SwapId, UserId, Role).
  // Joining needs a mailing address (saved to UserProfiles) and a recent passing Instagram check
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
      const result = await database.runTransactionAsync(async (tx) => {
        const [swaps] = await tx.run({
          sql: `SELECT CURRENT_DATE() BETWEEN SignUpOpens AND SignUpCloses AS IsOpen FROM Swaps WHERE SwapId = @swapId`,
          params: { swapId },
          json: true,
        });
        if (swaps.length === 0) {
          await tx.rollback();
          return 'missing' as const;
        }
        if (!(swaps[0] as { IsOpen: boolean }).IsOpen) {
          await tx.rollback();
          return 'closed' as const;
        }
        const checked = validateAddress(body.address);
        if ('error' in checked) {
          await tx.rollback();
          return { problem: checked.error };
        }
        const profile = await readProfile(tx, userId);
        if (!profile?.InstagramStatus) {
          await tx.rollback();
          return { problem: 'Please check your Instagram name before joining.' };
        }
        if (!profile.InstagramFresh) {
          await tx.rollback();
          return { problem: 'Please check your Instagram name again before joining.' };
        }
        const isPublic = profile.InstagramStatus === 'public';
        if (!isPublic && body.instagramPublicConfirmed !== true) {
          await tx.rollback();
          return { problem: "We couldn't confirm your Instagram is public. Please tick the box to say it is." };
        }

        tx.upsert('UserProfiles', { UserId: userId, ...addressColumns(checked.address), UpdatedAt: Spanner.COMMIT_TIMESTAMP });
        const [existing] = await tx.run({
          sql: `SELECT 1 AS Ok FROM SwapMembers WHERE SwapId = @swapId AND UserId = @userId AND Role = 'participant'`,
          params: { swapId, userId },
          json: true,
        });
        const member = { SwapId: swapId, UserId: userId, Role: 'participant', InstagramPublicConfirmed: isPublic ? null : true };
        if (existing.length === 0) {
          tx.insert('SwapMembers', { ...member, CreatedAt: Spanner.COMMIT_TIMESTAMP });
        } else {
          tx.update('SwapMembers', member);
        }
        await tx.commit();
        return 'joined' as const;
      });
      if (result === 'missing') return reply.code(404).send({ error: 'That swap was not found.' });
      if (result === 'closed') return reply.code(403).send({ error: 'Sign-up for this swap is not open.' });
      if (typeof result === 'object') return reply.code(400).send({ error: result.problem });
      return { joined: true };
    },
  );

  app.delete<{ Params: { swapId: string } }>(
    '/api/swaps/:swapId/membership',
    { ...auth, schema: { params: swapParamsSchema } },
    async (req, reply) => {
      const { swapId } = req.params;
      const userId = req.user!.userId;
      // Their pairings go too, so the manager sees who now needs a maker. Deleting a key that
      // doesn't exist is a no-op, so leaving twice is fine.
      await database.runTransactionAsync(async (tx) => {
        const [pairs] = await tx.run({
          sql: `SELECT MakerId, RecipientId FROM Assignments
                WHERE SwapId = @swapId AND (MakerId = @userId OR RecipientId = @userId)`,
          params: { swapId, userId },
          json: true,
        });
        const keys = (pairs as { MakerId: string; RecipientId: string }[]).map((p) => [swapId, p.MakerId, p.RecipientId]);
        if (keys.length) tx.deleteRows('Assignments', keys);
        tx.deleteRows('SwapMembers', [[swapId, userId, 'participant']]);
        await tx.commit();
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
      await database.runTransactionAsync(async (tx) => {
        tx.insert('Swaps', {
          SwapId: swapId,
          ...columns(req.body),
          CreatedBy: userId,
          CreatedAt: Spanner.COMMIT_TIMESTAMP,
          UpdatedAt: Spanner.COMMIT_TIMESTAMP,
        });
        tx.insert('SwapMembers', { SwapId: swapId, UserId: userId, Role: 'manager', CreatedAt: Spanner.COMMIT_TIMESTAMP });
        await tx.commit();
      });
      return reply.code(201).send({ swap: await getSwap(swapId) });
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
      await database.table('Swaps').update({ SwapId: swapId, ...columns(req.body), UpdatedAt: Spanner.COMMIT_TIMESTAMP });
      return { swap: await getSwap(swapId) };
    },
  );
}
