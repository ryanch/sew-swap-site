import { randomUUID } from 'node:crypto';
import { Spanner, type Transaction } from '@google-cloud/spanner';
import { grantBootstrapAdmin, rolesSubquery, type GlobalRole } from './roles';

export type AuthUser = { userId: string; email: string; displayName: string | null; roles: GlobalRole[] };
export type LoginResult = { user: AuthUser; isNewUser: boolean };

type UserRow = {
  UserId: string;
  Email: string;
  DisplayName: string | null;
  GoogleSub: string | null;
  Roles: GlobalRole[];
};

const USER_COLUMNS = `u.UserId, u.Email, u.DisplayName, u.GoogleSub, ${rolesSubquery('u')}`;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function toAuthUser(row: Pick<UserRow, 'UserId' | 'Email' | 'DisplayName' | 'Roles'>): AuthUser {
  return { userId: row.UserId, email: row.Email, displayName: row.DisplayName, roles: row.Roles ?? [] };
}

async function findOne(tx: Transaction, where: string, params: Record<string, string>) {
  const [rows] = await tx.run({
    sql: `SELECT ${USER_COLUMNS} FROM Users u WHERE ${where} LIMIT 1`,
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
  return toAuthUser({ ...row, Roles: [] });
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

/** Every login path ends here, so ADMIN_EMAILS users get the admin role on sign-in. */
function loggedIn(tx: Transaction, user: AuthUser, isNewUser: boolean): LoginResult {
  return { user: grantBootstrapAdmin(tx, user), isNewUser };
}

/** Email-token login: proving control of the inbox signs up or signs in. */
export async function findOrCreateByEmail(tx: Transaction, rawEmail: string): Promise<LoginResult> {
  const email = normalizeEmail(rawEmail);
  const existing = await findOne(tx, 'u.Email = @email', { email });
  if (existing) {
    markLoggedIn(tx, existing.UserId);
    return loggedIn(tx, toAuthUser(existing), false);
  }
  return loggedIn(tx, createUser(tx, email), true);
}

/** Google login: match by Google account id, then by verified email (linking it), else create. */
export async function findOrLinkGoogleUser(
  tx: Transaction,
  google: { sub: string; email: string; name?: string },
): Promise<LoginResult> {
  const email = normalizeEmail(google.email);
  const bySub = await findOne(tx, 'u.GoogleSub = @sub', { sub: google.sub });
  if (bySub) {
    markLoggedIn(tx, bySub.UserId);
    return loggedIn(tx, toAuthUser(bySub), false);
  }

  const byEmail = await findOne(tx, 'u.Email = @email', { email });
  if (byEmail) {
    const extra: Record<string, unknown> = {};
    if (!byEmail.GoogleSub) extra.GoogleSub = google.sub;
    if (!byEmail.DisplayName && google.name) extra.DisplayName = google.name;
    markLoggedIn(tx, byEmail.UserId, extra);
    return loggedIn(tx, toAuthUser({ ...byEmail, DisplayName: byEmail.DisplayName ?? google.name ?? null }), false);
  }

  return loggedIn(tx, createUser(tx, email, { GoogleSub: google.sub, DisplayName: google.name ?? null }), true);
}
