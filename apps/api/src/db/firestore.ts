import { Firestore, Timestamp, type CollectionReference, type Transaction } from '@google-cloud/firestore';
import type { FastifyReply } from 'fastify';
import { config } from '../config';

// When FIRESTORE_EMULATOR_HOST is set, the client talks to the emulator (no credentials needed).
// In Cloud Run it uses ADC and the project's (default) database.
export const db = new Firestore({ projectId: config.projectId, ignoreUndefinedProperties: true });

// Every collection is top-level and every query uses only equality filters, or one range/orderBy on a
// single field, so Firestore's automatic single-field indexes serve them. The emulator never asks for
// composite indexes, so a query that needs one would pass locally and fail in production.
// Field names match the old Spanner columns.
export const col = {
  hello: db.collection('helloMessages'),
  users: db.collection('users'), //                  {UserId}: Email, DisplayName, GoogleSub, Roles[], RoleGrants{role: {GrantedBy, GrantedAt}}, timestamps
  userEmails: db.collection('userEmails'), //        {Email}: UserId (keeps emails unique)
  userGoogleSubs: db.collection('userGoogleSubs'), // {GoogleSub}: UserId (keeps Google ids unique)
  userProfiles: db.collection('userProfiles'), //    {UserId}: address and Instagram columns
  instagramChecks: db.collection('instagramChecks'), // {CheckId}: UserId, CheckedAt, ExpiresAt, Input (post link), Handle, Result, Strategy
  sessions: db.collection('sessions'), //            {SessionIdHash}: UserId, CreatedAt, ExpiresAt, ...
  loginTokens: db.collection('loginTokens'), //      {TokenId}: Email, LinkTokenHash, CodeHash, Attempts, ExpiresAt, ConsumedAt, CreatedAt
  emailLog: db.collection('emailLog'), //            {EmailId}: UserId, SentAt, Kind, SwapId, Subject, Body, Status
  swaps: db.collection('swaps'), //                  {SwapId}: Title, Description, dates as 'YYYY-MM-DD', MakersPublishedAt/By, ...
  swapMembers: db.collection('swapMembers'), //      memberId(): SwapId, UserId, Role, CreatedAt, SkillLevel, PodId, InstagramPublicConfirmed
  pods: db.collection('pods'), //                    {PodId}: SwapId, Name, CreatedAt
  assignments: db.collection('assignments'), //      assignmentId(): SwapId, MakerId, RecipientId, CreatedBy, CreatedAt, ConfirmedAt, ShippedAt, Carrier, TrackingNumber
};

// Doc ids that stand in for the old composite primary keys. UUIDs and role names never contain '_'.
export const memberId = (swapId: string, userId: string, role: string) => `${swapId}_${userId}_${role}`;
export const assignmentId = (swapId: string, makerId: string, recipientId: string) => `${swapId}_${makerId}_${recipientId}`;

export const now = () => Timestamp.now();

/** A Timestamp as the API sends it, like Spanner's FORMAT_TIMESTAMP('%FT%TZ'): 2026-10-22T12:34:56Z. */
export function toIso(ts: Timestamp | null | undefined): string | null {
  return ts ? ts.toDate().toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
}

/** Today in UTC as YYYY-MM-DD, what CURRENT_DATE() gave. Swap dates are stored as these strings. */
export const todayUtc = () => new Date().toISOString().slice(0, 10);

/** Data of every doc in a query or getAll result, skipping missing docs. */
export function rows<T>(snaps: { exists: boolean; data(): unknown }[] | { docs: { data(): unknown }[] }): T[] {
  const list = Array.isArray(snaps) ? snaps.filter((s) => s.exists) : snaps.docs;
  return list.map((s) => s.data() as T);
}

/** Reads many docs by id (Firestore takes at most a few hundred per call, so this batches). */
export async function getMany<T>(
  ref: CollectionReference,
  ids: string[],
  tx?: Transaction,
): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 300) {
    const refs = unique.slice(i, i + 300).map((id) => ref.doc(id));
    if (refs.length === 0) continue;
    const snaps = tx ? await tx.getAll(...refs) : await db.getAll(...refs);
    for (const s of snaps) if (s.exists) out.set(s.id, s.data() as T);
  }
  return out;
}

export class Problem extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/**
 * Runs a read-write transaction (every read must come before any write). A thrown Problem rolls it
 * back and becomes an error reply, and the result is undefined.
 */
export async function inTransaction<T>(reply: FastifyReply, work: (tx: Transaction) => Promise<T>) {
  try {
    return await db.runTransaction(work);
  } catch (err) {
    if (err instanceof Problem) {
      reply.code(err.status).send({ error: err.message });
      return undefined;
    }
    throw err;
  }
}
