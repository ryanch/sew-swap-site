import { randomUUID } from 'node:crypto';
import type { DocumentReference, Transaction } from '@google-cloud/firestore';
import { col, now } from '../db/firestore';
import { needsBootstrapAdmin, withRole, type GlobalRole } from './roles';

export type AuthUser = { userId: string; email: string; displayName: string | null; roles: GlobalRole[] };
export type LoginResult = { user: AuthUser; isNewUser: boolean };

/** The `users/{UserId}` fields sign-in reads. */
export type UserRow = {
  UserId: string;
  Email: string;
  DisplayName: string | null;
  GoogleSub: string | null;
  Roles?: GlobalRole[];
};

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function toAuthUser(row: Pick<UserRow, 'UserId' | 'Email' | 'DisplayName' | 'Roles'>): AuthUser {
  return { userId: row.UserId, email: row.Email, displayName: row.DisplayName ?? null, roles: row.Roles ?? [] };
}

/** Follows a userEmails/userGoogleSubs doc to its user. */
async function findBy(tx: Transaction, indexRef: DocumentReference) {
  const index = await tx.get(indexRef);
  if (!index.exists) return null;
  const user = await tx.get(col.users.doc(index.get('UserId') as string));
  return user.exists ? (user.data() as UserRow) : null;
}

/** The `RoleGrants.admin` entry for ADMIN_EMAILS users: granted by no one. */
const bootstrapGrant = () => ({ GrantedBy: null, GrantedAt: now() });

function createUser(tx: Transaction, email: string, extra: { DisplayName?: string | null; GoogleSub?: string | null } = {}): LoginResult {
  const ts = now();
  const admin = needsBootstrapAdmin(email, []);
  const row = {
    UserId: randomUUID(),
    Email: email,
    DisplayName: extra.DisplayName ?? null,
    GoogleSub: extra.GoogleSub ?? null,
    Roles: admin ? (['admin'] as GlobalRole[]) : [],
    RoleGrants: admin ? { admin: bootstrapGrant() } : {},
    EmailVerifiedAt: ts,
    LastLoginAt: ts,
    CreatedAt: ts,
    UpdatedAt: ts,
  };
  tx.create(col.users.doc(row.UserId), row);
  tx.create(col.userEmails.doc(email), { UserId: row.UserId });
  if (row.GoogleSub) tx.create(col.userGoogleSubs.doc(row.GoogleSub), { UserId: row.UserId });
  return { user: toAuthUser(row), isNewUser: true };
}

/**
 * Every sign-in of an existing user ends here, after all the transaction's reads.
 * ADMIN_EMAILS users get the admin role back if it's missing.
 */
function markLoggedIn(tx: Transaction, row: UserRow, extra: Record<string, unknown> = {}): LoginResult {
  const ts = now();
  let roles = row.Roles ?? [];
  const update: Record<string, unknown> = { EmailVerifiedAt: ts, LastLoginAt: ts, UpdatedAt: ts, ...extra };
  if (needsBootstrapAdmin(row.Email, roles)) {
    roles = withRole(roles, 'admin');
    update.Roles = roles;
    update['RoleGrants.admin'] = bootstrapGrant();
  }
  tx.update(col.users.doc(row.UserId), update);
  return { user: toAuthUser({ ...row, Roles: roles }), isNewUser: false };
}

/** Email-token login: proving control of the inbox signs up or signs in. */
export async function findOrCreateByEmail(tx: Transaction, rawEmail: string): Promise<LoginResult> {
  const email = normalizeEmail(rawEmail);
  const existing = await findBy(tx, col.userEmails.doc(email));
  return existing ? markLoggedIn(tx, existing) : createUser(tx, email);
}

/** Google login: match by Google account id, then by verified email (linking it), else create. */
export async function findOrLinkGoogleUser(
  tx: Transaction,
  google: { sub: string; email: string; name?: string },
): Promise<LoginResult> {
  const email = normalizeEmail(google.email);
  const bySub = await findBy(tx, col.userGoogleSubs.doc(google.sub));
  if (bySub) return markLoggedIn(tx, bySub);

  const byEmail = await findBy(tx, col.userEmails.doc(email));
  if (byEmail) {
    const extra: Record<string, unknown> = {};
    if (!byEmail.GoogleSub) {
      extra.GoogleSub = google.sub;
      tx.create(col.userGoogleSubs.doc(google.sub), { UserId: byEmail.UserId });
    }
    if (!byEmail.DisplayName && google.name) extra.DisplayName = google.name;
    return markLoggedIn(tx, { ...byEmail, DisplayName: byEmail.DisplayName ?? google.name ?? null }, extra);
  }

  return createUser(tx, email, { GoogleSub: google.sub, DisplayName: google.name ?? null });
}
