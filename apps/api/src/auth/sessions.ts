import { Spanner, type Transaction } from '@google-cloud/spanner';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import { database } from '../db/spanner';
import { hmac, randomToken } from './crypto';
import { rolesSubquery } from './roles';
import { toAuthUser, type AuthUser } from './users';

export const SESSION_COOKIE = 'sid';

/** Buffers a Sessions insert in `tx`; returns the raw token for the cookie. */
export function createSession(tx: Transaction, userId: string, req: FastifyRequest): string {
  const token = randomToken();
  const ttlMs = config.auth.sessionTtlDays * 24 * 60 * 60 * 1000;
  tx.insert('Sessions', {
    SessionIdHash: hmac(token),
    UserId: userId,
    CreatedAt: Spanner.COMMIT_TIMESTAMP,
    ExpiresAt: new Date(Date.now() + ttlMs),
    UserAgent: (req.headers['user-agent'] ?? '').slice(0, 512),
    IpAddress: req.ip.slice(0, 64),
  });
  return token;
}

export async function getUserBySessionToken(token: string): Promise<AuthUser | null> {
  const [rows] = await database.run({
    sql: `SELECT u.UserId, u.Email, u.DisplayName, ${rolesSubquery('u')}
          FROM Sessions s JOIN Users u ON u.UserId = s.UserId
          WHERE s.SessionIdHash = @hash AND s.ExpiresAt > CURRENT_TIMESTAMP()`,
    params: { hash: hmac(token) },
    json: true,
  });
  const row = rows[0] as Parameters<typeof toAuthUser>[0] | undefined;
  return row ? toAuthUser(row) : null;
}

export async function deleteSession(token: string): Promise<void> {
  await database.table('Sessions').deleteRows([hmac(token)]);
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
