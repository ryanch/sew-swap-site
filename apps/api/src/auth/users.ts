import { randomUUID } from 'node:crypto';
import { Spanner, type Transaction } from '@google-cloud/spanner';

export type AuthUser = { userId: string; email: string; displayName: string | null };
export type LoginResult = { user: AuthUser; isNewUser: boolean };

type UserRow = { UserId: string; Email: string; DisplayName: string | null; GoogleSub: string | null };

const USER_COLUMNS = 'UserId, Email, DisplayName, GoogleSub';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toAuthUser(row: UserRow): AuthUser {
  return { userId: row.UserId, email: row.Email, displayName: row.DisplayName };
}

async function findOne(tx: Transaction, where: string, params: Record<string, string>) {
  const [rows] = await tx.run({
    sql: `SELECT ${USER_COLUMNS} FROM Users WHERE ${where} LIMIT 1`,
    params,
    json: true,
  });
  return (rows[0] as UserRow | undefined) ?? null;
}

function createUser(tx: Transaction, email: string, extra: Partial<UserRow> = {}): AuthUser {
  const row = {
    UserId: randomUUID(),
    Email: email,
    DisplayName: extra.DisplayName ?? null,
    GoogleSub: extra.GoogleSub ?? null,
    EmailVerifiedAt: Spanner.COMMIT_TIMESTAMP,
    LastLoginAt: Spanner.COMMIT_TIMESTAMP,
    CreatedAt: Spanner.COMMIT_TIMESTAMP,
    UpdatedAt: Spanner.COMMIT_TIMESTAMP,
  };
  tx.insert('Users', row);
  return toAuthUser(row);
}

function markLoggedIn(tx: Transaction, userId: string, extra: Record<string, unknown> = {}) {
  tx.update('Users', {
    UserId: userId,
    EmailVerifiedAt: Spanner.COMMIT_TIMESTAMP,
    LastLoginAt: Spanner.COMMIT_TIMESTAMP,
    UpdatedAt: Spanner.COMMIT_TIMESTAMP,
    ...extra,
  });
}

/** Email-token login: proving control of the inbox signs up or signs in. */
export async function findOrCreateByEmail(tx: Transaction, rawEmail: string): Promise<LoginResult> {
  const email = normalizeEmail(rawEmail);
  const existing = await findOne(tx, 'Email = @email', { email });
  if (existing) {
    markLoggedIn(tx, existing.UserId);
    return { user: toAuthUser(existing), isNewUser: false };
  }
  return { user: createUser(tx, email), isNewUser: true };
}

/** Google login: match by Google account id, then by verified email (linking it), else create. */
export async function findOrLinkGoogleUser(
  tx: Transaction,
  google: { sub: string; email: string; name?: string },
): Promise<LoginResult> {
  const email = normalizeEmail(google.email);
  const bySub = await findOne(tx, 'GoogleSub = @sub', { sub: google.sub });
  if (bySub) {
    markLoggedIn(tx, bySub.UserId);
    return { user: toAuthUser(bySub), isNewUser: false };
  }

  const byEmail = await findOne(tx, 'Email = @email', { email });
  if (byEmail) {
    const extra: Record<string, unknown> = {};
    if (!byEmail.GoogleSub) extra.GoogleSub = google.sub;
    if (!byEmail.DisplayName && google.name) extra.DisplayName = google.name;
    markLoggedIn(tx, byEmail.UserId, extra);
    return {
      user: toAuthUser({ ...byEmail, DisplayName: byEmail.DisplayName ?? google.name ?? null }),
      isNewUser: false,
    };
  }

  return {
    user: createUser(tx, email, { GoogleSub: google.sub, DisplayName: google.name ?? null }),
    isNewUser: true,
  };
}
