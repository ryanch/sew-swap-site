import { Spanner, type Transaction } from '@google-cloud/spanner';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import type { AuthUser } from './users';

/** Site-wide roles, stored in UserRoles. Admin can do everything; swap_manager can create swaps. */
export const GLOBAL_ROLES = ['admin', 'swap_manager'] as const;
export type GlobalRole = (typeof GLOBAL_ROLES)[number];

/**
 * Per-swap roles. They will key the SwapMembers table (SwapId, UserId, Role) once swaps exist.
 * A manager runs a swap they created or were added to; a helper is assigned pods; a participant signs up.
 */
export const SWAP_ROLES = ['manager', 'helper', 'participant'] as const;
export type SwapRole = (typeof SWAP_ROLES)[number];

/** Spanner subquery selecting a user's global roles; `alias` is the Users table alias. */
export const rolesSubquery = (alias: string) =>
  `ARRAY(SELECT r.Role FROM UserRoles r WHERE r.UserId = ${alias}.UserId ORDER BY r.Role) AS Roles`;

export function hasRole(user: AuthUser | null, role: GlobalRole): boolean {
  return !!user && (user.roles.includes('admin') || user.roles.includes(role));
}

/** preHandler: 401 when signed out, 403 without the role. */
export function requireRole(role: GlobalRole) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
    if (!hasRole(req.user, role)) return reply.code(403).send({ error: 'forbidden' });
  };
}

/** Emails in ADMIN_EMAILS are always admins; the role is (re)granted when they sign in. */
export function isBootstrapAdmin(email: string): boolean {
  return config.auth.adminEmails.includes(email);
}

/** Buffers the admin grant in the login transaction if the user is in ADMIN_EMAILS and lacks it. */
export function grantBootstrapAdmin(tx: Transaction, user: AuthUser): AuthUser {
  if (!isBootstrapAdmin(user.email) || user.roles.includes('admin')) return user;
  tx.insert('UserRoles', { UserId: user.userId, Role: 'admin', GrantedBy: null, GrantedAt: Spanner.COMMIT_TIMESTAMP });
  return { ...user, roles: [...user.roles, 'admin'].sort() as GlobalRole[] };
}
