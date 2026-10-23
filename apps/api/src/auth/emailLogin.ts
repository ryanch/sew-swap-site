import { randomUUID } from 'node:crypto';
import { Timestamp, type QueryDocumentSnapshot } from '@google-cloud/firestore';
import type { FastifyRequest } from 'fastify';
import { config } from '../config';
import { col, db, now } from '../db/firestore';
import { sendMail } from '../email/mailer';
import { hmac, randomCode, randomToken, safeEqual } from './crypto';
import { createSession } from './sessions';
import { findOrCreateByEmail, normalizeEmail, type LoginResult } from './users';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type RequestLoginResult = { ok: true } | { ok: false; reason: 'invalid_email' | 'rate_limited' };
export type VerifyResult = ({ ok: true; sessionToken: string } & LoginResult) | { ok: false };

type TokenRow = {
  TokenId: string;
  Email: string;
  CodeHash: string;
  Attempts: number;
  ExpiresAt: Timestamp;
  ConsumedAt: Timestamp | null;
  CreatedAt: Timestamp;
};

/** Unused and unexpired. */
const isLive = (t: TokenRow) => !t.ConsumedAt && t.ExpiresAt.toMillis() > Date.now();
const tokenRow = (d: QueryDocumentSnapshot) => d.data() as TokenRow;

export async function requestLogin(rawEmail: string, ip: string): Promise<RequestLoginResult> {
  const email = normalizeEmail(rawEmail);
  if (!EMAIL_RE.test(email) || email.length > 320) return { ok: false, reason: 'invalid_email' };

  const hourAgo = Date.now() - 60 * 60 * 1000;
  const sent = await col.loginTokens.where('Email', '==', email).get();
  const recent = sent.docs.filter((d) => tokenRow(d).CreatedAt.toMillis() > hourAgo).length;
  if (recent >= config.auth.maxLoginRequestsPerHour) return { ok: false, reason: 'rate_limited' };

  const linkToken = randomToken();
  const code = randomCode();
  const tokenId = randomUUID();
  await col.loginTokens.doc(tokenId).create({
    TokenId: tokenId,
    Email: email,
    LinkTokenHash: hmac(linkToken),
    CodeHash: hmac(`${email}:${code}`),
    Attempts: 0,
    ExpiresAt: Timestamp.fromMillis(Date.now() + config.auth.loginTokenTtlMinutes * 60 * 1000),
    ConsumedAt: null,
    CreatedAt: now(),
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
  return db.runTransaction(async (tx): Promise<VerifyResult> => {
    const found = await tx.get(col.loginTokens.where('LinkTokenHash', '==', hmac(linkToken)));
    const token = found.docs.find((d) => isLive(tokenRow(d)));
    if (!token) return { ok: false };
    const login = await findOrCreateByEmail(tx, tokenRow(token).Email);
    tx.update(token.ref, { ConsumedAt: now() });
    const sessionToken = createSession(tx, login.user.userId, req);
    return { ok: true, sessionToken, ...login };
  });
}

/** Redeem the 6-digit code. Checks every live token for the email; wrong guesses count against all of them. */
export async function verifyCode(rawEmail: string, code: string, req: FastifyRequest): Promise<VerifyResult> {
  const email = normalizeEmail(rawEmail);
  const codeHash = hmac(`${email}:${code.trim()}`);
  return db.runTransaction(async (tx): Promise<VerifyResult> => {
    const found = await tx.get(col.loginTokens.where('Email', '==', email));
    const tokens = found.docs.filter((d) => {
      const t = tokenRow(d);
      return isLive(t) && t.Attempts < config.auth.maxCodeAttempts;
    });
    const match = tokens.find((d) => safeEqual(tokenRow(d).CodeHash, codeHash));

    if (!match) {
      for (const d of tokens) tx.update(d.ref, { Attempts: tokenRow(d).Attempts + 1 });
      return { ok: false };
    }

    const login = await findOrCreateByEmail(tx, email);
    tx.update(match.ref, { ConsumedAt: now() });
    const sessionToken = createSession(tx, login.user.userId, req);
    return { ok: true, sessionToken, ...login };
  });
}
