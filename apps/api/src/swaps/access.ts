import type { Timestamp } from '@google-cloud/firestore';
import type { AuthUser } from '../auth/users';
import { hasRole } from '../auth/roles';
import { col, memberId, toIso } from '../db/firestore';

/** The `swaps/{SwapId}` doc. Dates are stored as YYYY-MM-DD strings, which is what the API sends. */
export type SwapDoc = {
  SwapId: string;
  Title: string;
  Description: string;
  MakingDeadline: string;
  PartnersAnnounced: string;
  ShipBy: string;
  SignUpOpens: string;
  SignUpCloses: string;
  MakersPublishedAt: Timestamp | null;
  MakersPublishedBy: string | null;
  CreatedBy: string;
  CreatedAt: Timestamp;
  UpdatedAt: Timestamp;
};

export function toSwap(doc: SwapDoc) {
  return {
    swapId: doc.SwapId,
    title: doc.Title,
    description: doc.Description,
    makingDeadline: doc.MakingDeadline,
    partnersAnnounced: doc.PartnersAnnounced,
    shipBy: doc.ShipBy,
    signUpOpens: doc.SignUpOpens,
    signUpCloses: doc.SignUpCloses,
    // Until then, nobody but the swap's managers can see who makes for whom.
    makersPublishedAt: toIso(doc.MakersPublishedAt),
  };
}

/** Newest sign-up first, then by title. */
export function bySignUpOpens(a: SwapDoc, b: SwapDoc) {
  if (a.SignUpOpens !== b.SignUpOpens) return a.SignUpOpens < b.SignUpOpens ? 1 : -1;
  return a.Title < b.Title ? -1 : a.Title > b.Title ? 1 : 0;
}

export async function getSwap(swapId: string) {
  const snap = await col.swaps.doc(swapId).get();
  return snap.exists ? toSwap(snap.data() as SwapDoc) : null;
}

/** Admins manage every swap; everyone else only swaps where they are a manager. */
export async function canManage(user: AuthUser, swapId: string): Promise<boolean> {
  if (hasRole(user, 'admin')) return true;
  return (await col.swapMembers.doc(memberId(swapId, user.userId, 'manager')).get()).exists;
}

export const swapParamsSchema = {
  type: 'object',
  required: ['swapId'],
  properties: { swapId: { type: 'string', maxLength: 36 } },
} as const;
