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
      return { swap, canEdit: await canManage(req.user!, swap.swapId) };
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
