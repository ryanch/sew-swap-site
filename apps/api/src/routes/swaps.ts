import { randomUUID } from 'node:crypto';
import { Spanner } from '@google-cloud/spanner';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/plugin';
import { hasRole, requireRole } from '../auth/roles';
import type { AuthUser } from '../auth/users';
import { database } from '../db/spanner';

type SwapRow = {
  SwapId: string;
  Title: string;
  Description: string;
  MakingDeadline: string;
  PartnersAnnounced: string;
  ShipBy: string;
  SignUpOpens: string;
  SignUpCloses: string;
};

// DATE columns are formatted in SQL so the API always sends YYYY-MM-DD strings.
const d = (col: string) => `FORMAT_DATE('%F', s.${col}) AS ${col}`;
const SWAP_COLUMNS = `s.SwapId, s.Title, s.Description, ${[
  'MakingDeadline',
  'PartnersAnnounced',
  'ShipBy',
  'SignUpOpens',
  'SignUpCloses',
]
  .map(d)
  .join(', ')}`;

function toSwap(row: SwapRow) {
  return {
    swapId: row.SwapId,
    title: row.Title,
    description: row.Description,
    makingDeadline: row.MakingDeadline,
    partnersAnnounced: row.PartnersAnnounced,
    shipBy: row.ShipBy,
    signUpOpens: row.SignUpOpens,
    signUpCloses: row.SignUpCloses,
  };
}

type MemberRow = { UserId: string; Email: string; DisplayName: string | null; JoinedAt: string };

async function getSwap(swapId: string) {
  const [rows] = await database.run({
    sql: `SELECT ${SWAP_COLUMNS} FROM Swaps s WHERE s.SwapId = @swapId`,
    params: { swapId },
    json: true,
  });
  const row = rows[0] as SwapRow | undefined;
  return row ? toSwap(row) : null;
}

/** Admins manage every swap; everyone else only swaps where they are a manager. */
async function canManage(user: AuthUser, swapId: string): Promise<boolean> {
  if (hasRole(user, 'admin')) return true;
  const [rows] = await database.run({
    sql: `SELECT 1 AS Ok FROM SwapMembers WHERE SwapId = @swapId AND UserId = @userId AND Role = 'manager'`,
    params: { swapId, userId: user.userId },
    json: true,
  });
  return rows.length > 0;
}

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
const swapParamsSchema = {
  type: 'object',
  required: ['swapId'],
  properties: { swapId: { type: 'string', maxLength: 36 } },
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

export async function swapRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireAuth };
  const manager = { preHandler: requireRole('swap_manager') };

  app.get('/api/swaps', auth, async () => {
    const [rows] = await database.run({
      sql: `SELECT ${SWAP_COLUMNS} FROM Swaps s ORDER BY s.SignUpOpens DESC, s.Title`,
      json: true,
    });
    return { swaps: (rows as SwapRow[]).map(toSwap) };
  });

  app.get('/api/swaps/mine', manager, async (req) => {
    const all = hasRole(req.user, 'admin');
    const [rows] = await database.run({
      sql: `SELECT ${SWAP_COLUMNS} FROM Swaps s
            WHERE @all OR EXISTS (SELECT 1 FROM SwapMembers m
                                  WHERE m.SwapId = s.SwapId AND m.UserId = @userId AND m.Role = 'manager')
            ORDER BY s.SignUpOpens DESC, s.Title`,
      params: { all, userId: req.user!.userId },
      json: true,
    });
    return { swaps: (rows as SwapRow[]).map(toSwap) };
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
      return {
        swap,
        canEdit,
        signUpStatus: (status[0] as { Status: string }).Status,
        membership: membership[0] ? { joinedAt: (membership[0] as { JoinedAt: string }).JoinedAt } : null,
      };
    },
  );

  // Joining and leaving act on the caller's own `participant` row. Any signed-in user may join,
  // including the swap's managers: SwapMembers is keyed (SwapId, UserId, Role).
  app.put<{ Params: { swapId: string } }>(
    '/api/swaps/:swapId/membership',
    { ...auth, schema: { params: swapParamsSchema } },
    async (req, reply) => {
      const { swapId } = req.params;
      const userId = req.user!.userId;
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
        const [existing] = await tx.run({
          sql: `SELECT 1 AS Ok FROM SwapMembers WHERE SwapId = @swapId AND UserId = @userId AND Role = 'participant'`,
          params: { swapId, userId },
          json: true,
        });
        if (existing.length === 0) {
          tx.insert('SwapMembers', { SwapId: swapId, UserId: userId, Role: 'participant', CreatedAt: Spanner.COMMIT_TIMESTAMP });
        }
        await tx.commit();
        return 'joined' as const;
      });
      if (result === 'missing') return reply.code(404).send({ error: 'That swap was not found.' });
      if (result === 'closed') return reply.code(403).send({ error: 'Sign-up for this swap is not open.' });
      return { joined: true };
    },
  );

  app.delete<{ Params: { swapId: string } }>(
    '/api/swaps/:swapId/membership',
    { ...auth, schema: { params: swapParamsSchema } },
    async (req, reply) => {
      // Deleting a key that doesn't exist is a no-op, so leaving twice is fine.
      await database.table('SwapMembers').deleteRows([[req.params.swapId, req.user!.userId, 'participant']]);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { swapId: string }; Querystring: { limit?: number; after?: string } }>(
    '/api/swaps/:swapId/members',
    {
      ...auth,
      schema: {
        params: swapParamsSchema,
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
            after: { type: 'string', maxLength: 36 },
          },
        },
      },
    },
    async (req, reply) => {
      const { swapId } = req.params;
      if (!(await getSwap(swapId))) return reply.code(404).send({ error: 'That swap was not found.' });
      if (!(await canManage(req.user!, swapId))) {
        return reply.code(403).send({ error: "You can't see who joined this swap." });
      }
      const limit = req.query.limit ?? 100;
      // Keyset pagination on the primary key: each page is a range scan inside the swap's rows.
      const [[rows], [counts]] = await Promise.all([
        database.run({
          sql: `SELECT m.UserId, u.Email, u.DisplayName, FORMAT_TIMESTAMP('%FT%TZ', m.CreatedAt) AS JoinedAt
                FROM SwapMembers m JOIN Users u ON u.UserId = m.UserId
                WHERE m.SwapId = @swapId AND m.Role = 'participant' AND m.UserId > @after
                ORDER BY m.UserId
                LIMIT @limit`,
          params: { swapId, after: req.query.after ?? '', limit: Spanner.int(limit + 1) },
          json: true,
        }),
        database.run({
          sql: `SELECT COUNT(*) AS Total FROM SwapMembers WHERE SwapId = @swapId AND Role = 'participant'`,
          params: { swapId },
          json: true,
        }),
      ]);
      const page = (rows as MemberRow[]).slice(0, limit);
      return {
        members: page.map((r) => ({
          userId: r.UserId,
          email: r.Email,
          displayName: r.DisplayName,
          joinedAt: r.JoinedAt,
        })),
        total: Number((counts[0] as { Total: number }).Total),
        nextCursor: rows.length > limit ? page[page.length - 1].UserId : null,
      };
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
