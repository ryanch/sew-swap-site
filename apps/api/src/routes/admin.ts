import { Spanner } from '@google-cloud/spanner';
import type { FastifyInstance } from 'fastify';
import { GLOBAL_ROLES, isBootstrapAdmin, requireRole, rolesSubquery, type GlobalRole } from '../auth/roles';
import { database } from '../db/spanner';

type AdminUserRow = { UserId: string; Email: string; DisplayName: string | null; Roles: GlobalRole[] };

const ADMIN_USER_COLUMNS = `u.UserId, u.Email, u.DisplayName, ${rolesSubquery('u')}`;

function toAdminUser(row: AdminUserRow) {
  return {
    userId: row.UserId,
    email: row.Email,
    displayName: row.DisplayName,
    roles: row.Roles ?? [],
    bootstrapAdmin: isBootstrapAdmin(row.Email),
  };
}

async function getAdminUser(userId: string) {
  const [rows] = await database.run({
    sql: `SELECT ${ADMIN_USER_COLUMNS} FROM Users u WHERE u.UserId = @userId`,
    params: { userId },
    json: true,
  });
  const row = rows[0] as AdminUserRow | undefined;
  return row ? toAdminUser(row) : null;
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
      const [rows] = await database.run({
        sql: `SELECT ${ADMIN_USER_COLUMNS} FROM Users u
              WHERE @q = '' OR STRPOS(u.Email, @q) > 0 OR STRPOS(LOWER(IFNULL(u.DisplayName, '')), @q) > 0
              ORDER BY u.CreatedAt DESC
              LIMIT 100`,
        params: { q },
        json: true,
      });
      return { users: (rows as AdminUserRow[]).map(toAdminUser) };
    },
  );

  app.put<{ Params: RoleParams }>(
    '/api/admin/users/:userId/roles/:role',
    { ...admin, schema: { params: roleParamsSchema } },
    async (req, reply) => {
      const { userId, role } = req.params;
      const user = await getAdminUser(userId);
      if (!user) return reply.code(404).send({ error: 'That user was not found.' });
      if (!user.roles.includes(role)) {
        await database.table('UserRoles').insert({
          UserId: userId,
          Role: role,
          GrantedBy: req.user!.userId,
          GrantedAt: Spanner.COMMIT_TIMESTAMP,
        });
      }
      return { user: await getAdminUser(userId) };
    },
  );

  app.delete<{ Params: RoleParams }>(
    '/api/admin/users/:userId/roles/:role',
    { ...admin, schema: { params: roleParamsSchema } },
    async (req, reply) => {
      const { userId, role } = req.params;
      const user = await getAdminUser(userId);
      if (!user) return reply.code(404).send({ error: 'That user was not found.' });
      if (role === 'admin' && userId === req.user!.userId) {
        return reply.code(400).send({ error: "You can't remove your own Admin role." });
      }
      if (role === 'admin' && user.bootstrapAdmin) {
        return reply.code(400).send({ error: 'This person is an admin through the ADMIN_EMAILS setting.' });
      }
      await database.table('UserRoles').deleteRows([[userId, role]]);
      return { user: await getAdminUser(userId) };
    },
  );
}
