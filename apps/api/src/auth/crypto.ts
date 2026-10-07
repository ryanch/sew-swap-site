import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from '../config';

/** 256-bit URL-safe random token (session ids, magic-link tokens). */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 6-digit numeric code, zero-padded. */
export function randomCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** Keyed hash so stored values can't be used or brute-forced without AUTH_SECRET. */
export function hmac(value: string): string {
  return createHmac('sha256', config.auth.secret).update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
