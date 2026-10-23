import { Timestamp, type Transaction } from '@google-cloud/firestore';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import { col, now } from '../db/firestore';
import { hmac, randomToken } from './crypto';
import { toAuthUser, type AuthUser, type UserRow } from './users';

export const SESSION_COOKIE = 'sid';

/** Adds a sessions doc in `tx` (a write, so call it after the transaction's reads); returns the raw token for the cookie. */
export function createSession(tx: Transaction, userId: string, req: FastifyRequest): string {
  const token = randomToken();
  const ttlMs = config.auth.sessionTtlDays * 24 * 60 * 60 * 1000;
  tx.create(col.sessions.doc(hmac(token)), {
    SessionIdHash: hmac(token),
    UserId: userId,
    CreatedAt: now(),
    ExpiresAt: Timestamp.fromMillis(Date.now() + ttlMs),
    UserAgent: (req.headers['user-agent'] ?? '').slice(0, 512),
    IpAddress: req.ip.slice(0, 64),
  });
  return token;
}

export async function getUserBySessionToken(token: string): Promise<AuthUser | null> {
  const session = await col.sessions.doc(hmac(token)).get();
  if (!session.exists) return null;
  const expiresAt = session.get('ExpiresAt') as Timestamp;
  if (expiresAt.toMillis() <= Date.now()) return null;
  const user = await col.users.doc(session.get('UserId') as string).get();
  return user.exists ? toAuthUser(user.data() as UserRow) : null;
}

export async function deleteSession(token: string): Promise<void> {
  await col.sessions.doc(hmac(token)).delete();
}

export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.auth.cookieSecure,
    maxAge: config.auth.sessionTtlDays * 24 * 60 * 60, // seconds
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}
