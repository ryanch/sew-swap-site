import { randomUUID } from 'node:crypto';
import { Spanner } from '@google-cloud/spanner';
import type { FastifyRequest } from 'fastify';
import { config } from '../config';
import { database } from '../db/spanner';
import { sendMail } from '../email/mailer';
import { hmac, randomCode, randomToken, safeEqual } from './crypto';
import { createSession } from './sessions';
import { findOrCreateByEmail, normalizeEmail, type LoginResult } from './users';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type RequestLoginResult = { ok: true } | { ok: false; reason: 'invalid_email' | 'rate_limited' };
export type VerifyResult = ({ ok: true; sessionToken: string } & LoginResult) | { ok: false };

export async function requestLogin(rawEmail: string, ip: string): Promise<RequestLoginResult> {
  const email = normalizeEmail(rawEmail);
  if (!EMAIL_RE.test(email) || email.length > 320) return { ok: false, reason: 'invalid_email' };

  const [countRows] = await database.run({
    sql: `SELECT COUNT(*) AS n FROM LoginTokens
          WHERE Email = @email AND CreatedAt > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)`,
    params: { email },
    json: true,
  });
  if (Number((countRows[0] as { n: number }).n) >= config.auth.maxLoginRequestsPerHour) {
    return { ok: false, reason: 'rate_limited' };
  }

  const linkToken = randomToken();
  const code = randomCode();
  await database.table('LoginTokens').insert({
    TokenId: randomUUID(),
    Email: email,
    LinkTokenHash: hmac(linkToken),
    CodeHash: hmac(`${email}:${code}`),
    Attempts: 0,
    ExpiresAt: new Date(Date.now() + config.auth.loginTokenTtlMinutes * 60 * 1000),
    CreatedAt: Spanner.COMMIT_TIMESTAMP,
    RequestIp: ip.slice(0, 64),
  });

  await sendLoginEmail(email, linkToken, code);
  return { ok: true };
}

function sendLoginEmail(email: string, linkToken: string, code: string) {
  const link = `${config.appBaseUrl}/login/verify?token=${encodeURIComponent(linkToken)}`;
  const minutes = config.auth.loginTokenTtlMinutes;
  const text = [
    'Hello!',
    '',
    'Click this link to sign in to Sew Swap:',
    link,
    '',
    `Or type this code on the sign-in page: ${code}`,
    '',
    `The link and code work once and expire in ${minutes} minutes.`,
    "If you didn't ask to sign in, you can ignore this email.",
  ].join('\n');
  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 18px; line-height: 1.5; max-width: 520px">
      <p>Hello!</p>
      <p>Click the button below to sign in to Sew Swap:</p>
      <p><a href="${link}" style="display:inline-block;background:#1a7f37;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:20px">Sign in to Sew Swap</a></p>
      <p>Or type this code on the sign-in page:</p>
      <p style="font-size:32px;font-weight:bold;letter-spacing:6px">${code}</p>
      <p style="color:#555;font-size:15px">The button and code work once and expire in ${minutes} minutes.
      If you didn't ask to sign in, you can ignore this email.</p>
    </div>`;
  return sendMail(email, `Your Sew Swap sign-in code: ${code}`, text, html);
}

/** Redeem the magic link. Consumes the token, finds/creates the user, and opens a session atomically. */
export async function verifyLinkToken(linkToken: string, req: FastifyRequest): Promise<VerifyResult> {
  return database.runTransactionAsync(async (tx) => {
    const [rows] = await tx.run({
      sql: `SELECT TokenId, Email FROM LoginTokens
            WHERE LinkTokenHash = @hash AND ConsumedAt IS NULL AND ExpiresAt > CURRENT_TIMESTAMP()`,
      params: { hash: hmac(linkToken) },
      json: true,
    });
    const token = rows[0] as { TokenId: string; Email: string } | undefined;
    if (!token) {
      await tx.end();
      return { ok: false };
    }
    tx.update('LoginTokens', { TokenId: token.TokenId, ConsumedAt: Spanner.COMMIT_TIMESTAMP });
    const login = await findOrCreateByEmail(tx, token.Email);
    const sessionToken = createSession(tx, login.user.userId, req);
    await tx.commit();
    return { ok: true, sessionToken, ...login };
  });
}

/** Redeem the 6-digit code. Checks every live token for the email; wrong guesses count against all of them. */
export async function verifyCode(rawEmail: string, code: string, req: FastifyRequest): Promise<VerifyResult> {
  const email = normalizeEmail(rawEmail);
  const codeHash = hmac(`${email}:${code.trim()}`);
  const result = await database.runTransactionAsync(async (tx) => {
    const [rows] = await tx.run({
      sql: `SELECT TokenId, CodeHash, Attempts FROM LoginTokens
            WHERE Email = @email AND ConsumedAt IS NULL AND ExpiresAt > CURRENT_TIMESTAMP()
              AND Attempts < ${config.auth.maxCodeAttempts}`,
      params: { email },
      json: true,
    });
    const tokens = rows as { TokenId: string; CodeHash: string; Attempts: number }[];
    const match = tokens.find((t) => safeEqual(t.CodeHash, codeHash));

    if (!match) {
      for (const t of tokens) {
        tx.update('LoginTokens', { TokenId: t.TokenId, Attempts: Number(t.Attempts) + 1 });
      }
      await tx.commit();
      return { ok: false } as const;
    }

    tx.update('LoginTokens', { TokenId: match.TokenId, ConsumedAt: Spanner.COMMIT_TIMESTAMP });
    const login = await findOrCreateByEmail(tx, email);
    const sessionToken = createSession(tx, login.user.userId, req);
    await tx.commit();
    return { ok: true, sessionToken, ...login } as const;
  });
  return result;
}
