import cookie from '@fastify/cookie';
import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import { getUserBySessionToken, SESSION_COOKIE } from './sessions';
import type { AuthUser } from './users';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

/** Parses cookies and attaches `request.user` from the session cookie on every request. */
export const authPlugin = fp(async (app) => {
  await app.register(cookie, { secret: config.auth.secret });
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    req.user = token ? await getUserBySessionToken(token) : null;
  });
});

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
}
