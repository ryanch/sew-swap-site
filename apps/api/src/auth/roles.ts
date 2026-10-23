import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import type { AuthUser } from './users';

/** Site-wide roles, stored in the user doc's sorted `Roles` array. Admin can do everything; swap_manager can create swaps. */
export const GLOBAL_ROLES = ['admin', 'swap_manager'] as const;
export type GlobalRole = (typeof GLOBAL_ROLES)[number];

/**
 * Per-swap roles, stored in swapMembers docs (one per swap, user and role).
 * A manager runs a swap they created or were added to; a helper is assigned pods; a participant signs up.
 */
export const SWAP_ROLES = ['manager', 'helper', 'participant'] as const;
export type SwapRole = (typeof SWAP_ROLES)[number];

/** `roles` plus `role`, sorted and without repeats, as `Roles` is stored. */
export function withRole(roles: GlobalRole[], role: GlobalRole): GlobalRole[] {
  return [...new Set([...roles, role])].sort();
}

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

/** True when a sign-in should (re)grant admin: the email is in ADMIN_EMAILS and the role is missing. */
export function needsBootstrapAdmin(email: string, roles: GlobalRole[]): boolean {
  return isBootstrapAdmin(email) && !roles.includes('admin');
}
