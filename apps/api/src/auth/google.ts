import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import { db } from '../db/firestore';
import { randomToken } from './crypto';
import { createSession } from './sessions';
import { findOrLinkGoogleUser, type LoginResult } from './users';

const OAUTH_COOKIE = 'g_oauth';
const OAUTH_COOKIE_PATH = '/api/auth/google';

function client() {
  return new OAuth2Client({
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    redirectUri: config.google.redirectUri,
  });
}

/** Builds the Google consent URL and stores state + PKCE verifier in a short-lived signed cookie. */
export async function startGoogleLogin(reply: FastifyReply): Promise<string> {
  const oauth = client();
  const state = randomToken();
  const { codeVerifier, codeChallenge } = await oauth.generateCodeVerifierAsync();
  reply.setCookie(OAUTH_COOKIE, JSON.stringify({ state, codeVerifier }), {
    path: OAUTH_COOKIE_PATH,
    httpOnly: true,
    sameSite: 'lax',
    secure: config.auth.cookieSecure,
    signed: true,
    maxAge: 600,
  });
  return oauth.generateAuthUrl({
    scope: ['openid', 'email', 'profile'],
    state,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
    prompt: 'select_account',
  });
}

export async function finishGoogleLogin(
  req: FastifyRequest<{ Querystring: { code?: string; state?: string } }>,
  reply: FastifyReply,
): Promise<({ sessionToken: string } & LoginResult) | null> {
  const raw = req.cookies[OAUTH_COOKIE];
  reply.clearCookie(OAUTH_COOKIE, { path: OAUTH_COOKIE_PATH });
  if (!raw || !req.query.code || !req.query.state) return null;

  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  const saved = JSON.parse(unsigned.value) as { state: string; codeVerifier: string };
  if (saved.state !== req.query.state) return null;

  const oauth = client();
  const { tokens } = await oauth.getToken({ code: req.query.code, codeVerifier: saved.codeVerifier });
  if (!tokens.id_token) return null;
  const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: config.google.clientId });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email || !payload.email_verified) return null;

  return db.runTransaction(async (tx) => {
    const login = await findOrLinkGoogleUser(tx, {
      sub: payload.sub,
      email: payload.email!,
      name: payload.name,
    });
    const sessionToken = createSession(tx, login.user.userId, req);
    return { sessionToken, ...login };
  });
}
