import { expect } from '@playwright/test';

const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';

type SearchResult = { messages: { ID: string; Created: string }[] };
type Message = { Text: string; HTML: string; Subject: string };

export type LoginEmail = { token: string; code: string; text: string };

/** Unique per test so tests don't see each other's mail. */
export function uniqueEmail(prefix = 'e2e'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

/**
 * Waits for the newest sign-in email to `to` (optionally newer than `after`)
 * and pulls out the magic-link token and 6-digit code.
 */
export async function waitForLoginEmail(to: string, opts: { excludeIds?: string[] } = {}): Promise<LoginEmail & { id: string }> {
  let id = '';
  await expect
    .poll(
      async () => {
        const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
        const data = (await res.json()) as SearchResult;
        const fresh = data.messages.filter((m) => !opts.excludeIds?.includes(m.ID));
        id = fresh[0]?.ID ?? '';
        return id;
      },
      { message: `sign-in email to ${to}`, timeout: 15_000 },
    )
    .not.toBe('');

  const res = await fetch(`${MAILPIT_URL}/api/v1/message/${id}`);
  const msg = (await res.json()) as Message;
  const token = msg.Text.match(/\/login\/verify\?token=([A-Za-z0-9_%-]+)/)?.[1];
  const code = msg.Text.match(/code on the sign-in page: (\d{6})/)?.[1];
  if (!token || !code) throw new Error(`Could not parse sign-in email:\n${msg.Text}`);
  return { id, token: decodeURIComponent(token), code, text: msg.Text };
}
