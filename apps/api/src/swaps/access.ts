import type { AuthUser } from '../auth/users';
import { hasRole } from '../auth/roles';
import { database } from '../db/spanner';

export type SwapRow = {
  SwapId: string;
  Title: string;
  Description: string;
  MakingDeadline: string;
  PartnersAnnounced: string;
  ShipBy: string;
  SignUpOpens: string;
  SignUpCloses: string;
  MakersPublishedAt: string | null;
};

// DATE columns are formatted in SQL so the API always sends YYYY-MM-DD strings.
const d = (col: string) => `FORMAT_DATE('%F', s.${col}) AS ${col}`;
export const SWAP_COLUMNS = `s.SwapId, s.Title, s.Description, ${[
  'MakingDeadline',
  'PartnersAnnounced',
  'ShipBy',
  'SignUpOpens',
  'SignUpCloses',
]
  .map(d)
  .join(', ')}, FORMAT_TIMESTAMP('%FT%TZ', s.MakersPublishedAt) AS MakersPublishedAt`;

export function toSwap(row: SwapRow) {
  return {
    swapId: row.SwapId,
    title: row.Title,
    description: row.Description,
    makingDeadline: row.MakingDeadline,
    partnersAnnounced: row.PartnersAnnounced,
    shipBy: row.ShipBy,
    signUpOpens: row.SignUpOpens,
    signUpCloses: row.SignUpCloses,
    // Until then, nobody but the swap's managers can see who makes for whom.
    makersPublishedAt: row.MakersPublishedAt,
  };
}

export async function getSwap(swapId: string) {
  const [rows] = await database.run({
    sql: `SELECT ${SWAP_COLUMNS} FROM Swaps s WHERE s.SwapId = @swapId`,
    params: { swapId },
    json: true,
  });
  const row = rows[0] as SwapRow | undefined;
  return row ? toSwap(row) : null;
}

/** Admins manage every swap; everyone else only swaps where they are a manager. */
export async function canManage(user: AuthUser, swapId: string): Promise<boolean> {
  if (hasRole(user, 'admin')) return true;
  const [rows] = await database.run({
    sql: `SELECT 1 AS Ok FROM SwapMembers WHERE SwapId = @swapId AND UserId = @userId AND Role = 'manager'`,
    params: { swapId, userId: user.userId },
    json: true,
  });
  return rows.length > 0;
}

export const swapParamsSchema = {
  type: 'object',
  required: ['swapId'],
  properties: { swapId: { type: 'string', maxLength: 36 } },
} as const;
