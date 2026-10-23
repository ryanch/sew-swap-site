import { FieldValue, type Timestamp } from '@google-cloud/firestore';
import type { FastifyInstance } from 'fastify';
import { GLOBAL_ROLES, isBootstrapAdmin, requireRole, withRole, type GlobalRole } from '../auth/roles';
import { col, db, now } from '../db/firestore';

type AdminUserRow = { UserId: string; Email: string; DisplayName: string | null; Roles?: GlobalRole[]; CreatedAt: Timestamp };

function toAdminUser(row: AdminUserRow) {
  return {
    userId: row.UserId,
    email: row.Email,
    displayName: row.DisplayName ?? null,
    roles: row.Roles ?? [],
    bootstrapAdmin: isBootstrapAdmin(row.Email),
  };
}

/**
 * Grants (`add`) or removes one role in a transaction, so two admins editing at once can't lose a change.
 * Returns the user as it is afterwards, or null if there's no such user.
 */
function changeRole(userId: string, role: GlobalRole, add: boolean, by: string) {
  return db.runTransaction(async (tx) => {
    const ref = col.users.doc(userId);
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const row = snap.data() as AdminUserRow;
    const roles = row.Roles ?? [];
    const has = roles.includes(role);
    if (add && !has) {
      row.Roles = withRole(roles, role);
      tx.update(ref, { Roles: row.Roles, [`RoleGrants.${role}`]: { GrantedBy: by, GrantedAt: now() }, UpdatedAt: now() });
    } else if (!add && has) {
      row.Roles = roles.filter((r) => r !== role);
      tx.update(ref, { Roles: row.Roles, [`RoleGrants.${role}`]: FieldValue.delete(), UpdatedAt: now() });
    }
    return toAdminUser(row);
  });
}

type RoleParams = { userId: string; role: GlobalRole };
const roleParamsSchema = {
  type: 'object',
  required: ['userId', 'role'],
  properties: { userId: { type: 'string', maxLength: 36 }, role: { type: 'string', enum: GLOBAL_ROLES } },
} as const;

export async function adminRoutes(app: FastifyInstance) {
  const admin = { preHandler: requireRole('admin') };

  app.get<{ Querystring: { q?: string } }>(
    '/api/admin/users',
    { ...admin, schema: { querystring: { type: 'object', properties: { q: { type: 'string', maxLength: 320 } } } } },
    async (req) => {
      const q = (req.query.q ?? '').trim().toLowerCase();
      const fields = ['UserId', 'Email', 'DisplayName', 'Roles', 'CreatedAt'];
      if (!q) {
        const recent = await col.users.orderBy('CreatedAt', 'desc').limit(100).select(...fields).get();
        return { users: recent.docs.map((d) => toAdminUser(d.data() as AdminUserRow)) };
      }
      // Firestore can't search inside strings, so this reads every user. Fine at swap-community sizes.
      const all = await col.users.select(...fields).get();
      const users = all.docs
        .map((d) => d.data() as AdminUserRow)
        .filter((u) => u.Email.includes(q) || (u.DisplayName ?? '').toLowerCase().includes(q))
        .sort((a, b) => b.CreatedAt.toMillis() - a.CreatedAt.toMillis())
        .slice(0, 100);
      return { users: users.map(toAdminUser) };
    },
  );

  app.put<{ Params: RoleParams }>(
    '/api/admin/users/:userId/roles/:role',
    { ...admin, schema: { params: roleParamsSchema } },
    async (req, reply) => {
      const user = await changeRole(req.params.userId, req.params.role, true, req.user!.userId);
      if (!user) return reply.code(404).send({ error: 'That user was not found.' });
      return { user };
    },
  );

  app.delete<{ Params: RoleParams }>(
    '/api/admin/users/:userId/roles/:role',
    { ...admin, schema: { params: roleParamsSchema } },
    async (req, reply) => {
      const { userId, role } = req.params;
      const snap = await col.users.doc(userId).get();
      if (!snap.exists) return reply.code(404).send({ error: 'That user was not found.' });
      if (role === 'admin' && userId === req.user!.userId) {
        return reply.code(400).send({ error: "You can't remove your own Admin role." });
      }
      if (role === 'admin' && isBootstrapAdmin(snap.get('Email') as string)) {
        return reply.code(400).send({ error: 'This person is an admin through the ADMIN_EMAILS setting.' });
      }
      const user = await changeRole(userId, role, false, req.user!.userId);
      if (!user) return reply.code(404).send({ error: 'That user was not found.' });
      return { user };
    },
  );
}
