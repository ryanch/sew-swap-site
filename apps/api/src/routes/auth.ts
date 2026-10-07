import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { requestLogin, verifyCode, verifyLinkToken, type VerifyResult } from '../auth/emailLogin';
import { finishGoogleLogin, startGoogleLogin } from '../auth/google';
import { requireAuth } from '../auth/plugin';
import { clearSessionCookie, deleteSession, SESSION_COOKIE, setSessionCookie } from '../auth/sessions';

const emailSchema = { type: 'string', minLength: 3, maxLength: 320 } as const;

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/auth/config', async () => ({ google: config.google.enabled }));

  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => ({ user: req.user }));

  app.post<{ Body: { email: string } }>(
    '/api/auth/email/request',
    {
      schema: {
        body: { type: 'object', required: ['email'], properties: { email: emailSchema } },
      },
    },
    async (req, reply) => {
      const result = await requestLogin(req.body.email, req.ip);
      if (result.ok) return { ok: true };
      if (result.reason === 'rate_limited') {
        return reply.code(429).send({ error: 'Too many sign-in emails. Please wait a while and try again.' });
      }
      return reply.code(400).send({ error: 'Please enter a valid email address.' });
    },
  );

  const finishLogin = (reply: Parameters<typeof setSessionCookie>[0], result: VerifyResult, error: string) => {
    if (!result.ok) return reply.code(400).send({ error });
    setSessionCookie(reply, result.sessionToken);
    return reply.send({ user: result.user, isNewUser: result.isNewUser });
  };

  app.post<{ Body: { token: string } }>(
    '/api/auth/email/verify-link',
    {
      schema: {
        body: { type: 'object', required: ['token'], properties: { token: { type: 'string', maxLength: 128 } } },
      },
    },
    async (req, reply) =>
      finishLogin(reply, await verifyLinkToken(req.body.token, req), 'This link has expired or was already used.'),
  );

  app.post<{ Body: { email: string; code: string } }>(
    '/api/auth/email/verify-code',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'code'],
          properties: { email: emailSchema, code: { type: 'string', pattern: '^\\s*\\d{6}\\s*$' } },
        },
      },
    },
    async (req, reply) =>
      finishLogin(
        reply,
        await verifyCode(req.body.email, req.body.code, req),
        'That code is not right, or it has expired. Check the email and try again.',
      ),
  );

  app.get('/api/auth/google/start', async (_req, reply) => {
    if (!config.google.enabled) return reply.code(404).send({ error: 'Google sign-in is not enabled' });
    return reply.redirect(await startGoogleLogin(reply));
  });

  app.get<{ Querystring: { code?: string; state?: string } }>('/api/auth/google/callback', async (req, reply) => {
    if (!config.google.enabled) return reply.code(404).send({ error: 'Google sign-in is not enabled' });
    try {
      const result = await finishGoogleLogin(req, reply);
      if (!result) return reply.redirect('/login?error=google');
      setSessionCookie(reply, result.sessionToken);
      return reply.redirect(result.isNewUser ? '/?welcome=1' : '/');
    } catch (err) {
      req.log.error(err, 'Google sign-in failed');
      return reply.redirect('/login?error=google');
    }
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await deleteSession(token);
    clearSessionCookie(reply);
    return { ok: true };
  });
}
