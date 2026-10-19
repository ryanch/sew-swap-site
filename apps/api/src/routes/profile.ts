import { randomUUID } from 'node:crypto';
import { Spanner, type Database, type Transaction } from '@google-cloud/spanner';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/plugin';
import { config } from '../config';
import { database } from '../db/spanner';
import { checkInstagram } from '../instagram';
import { cleanInstagramHandle } from '../instagram/handle';
import type { Address } from '../profile/address';

type ProfileRow = {
  RecipientName: string | null;
  Country: string | null;
  AddressLine1: string | null;
  AddressLine2: string | null;
  City: string | null;
  Region: string | null;
  PostalCode: string | null;
  InstagramHandle: string | null;
  InstagramStatus: 'public' | 'exists' | 'unknown' | null;
  InstagramCheckedAt: string | null;
  InstagramFresh: boolean | null;
};

/** The caller's saved sign-up info, or null. `InstagramFresh` is false once a passing check is too old to join with. */
export async function readProfile(runner: Database | Transaction, userId: string): Promise<ProfileRow | null> {
  const [rows] = await runner.run({
    sql: `SELECT RecipientName, Country, AddressLine1, AddressLine2, City, Region, PostalCode,
                 InstagramHandle, InstagramStatus,
                 FORMAT_TIMESTAMP('%FT%TZ', InstagramCheckedAt) AS InstagramCheckedAt,
                 InstagramCheckedAt > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${config.instagram.checkValidDays} DAY) AS InstagramFresh
          FROM UserProfiles WHERE UserId = @userId`,
    params: { userId },
    json: true,
  });
  return (rows[0] as ProfileRow | undefined) ?? null;
}

export function addressColumns(a: Address) {
  return {
    RecipientName: a.name,
    Country: a.country,
    AddressLine1: a.line1,
    AddressLine2: a.line2 || null,
    City: a.city,
    Region: a.region || null,
    PostalCode: a.postalCode || null,
  };
}

/**
 * Rate limit for Instagram checks, decided and recorded in one transaction so parallel
 * requests can't slip past it. Returns the seconds to wait, or null with the new check's id.
 */
async function startCheck(userId: string, input: string, handle: string) {
  const { minSecondsBetweenChecks, maxChecksPerHour } = config.instagram;
  return database.runTransactionAsync(async (tx) => {
    const [rows] = await tx.run({
      sql: `SELECT COUNT(*) AS N,
                   TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), MAX(CheckedAt), MILLISECOND) AS SinceLastMs,
                   TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), MIN(CheckedAt), SECOND) AS SinceFirst
            FROM InstagramChecks
            WHERE UserId = @userId AND CheckedAt > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)`,
      params: { userId },
      json: true,
    });
    const row = rows[0] as { N: number; SinceLastMs: number | null; SinceFirst: number | null };
    let wait = 0;
    if (Number(row.N) >= maxChecksPerHour) wait = 3600 - Number(row.SinceFirst);
    else if (row.SinceLastMs !== null && Number(row.SinceLastMs) < minSecondsBetweenChecks * 1000) {
      wait = Math.ceil((minSecondsBetweenChecks * 1000 - Number(row.SinceLastMs)) / 1000);
    }
    if (wait > 0) {
      await tx.rollback();
      return { retryAfterSeconds: Math.max(1, wait), checkId: null };
    }
    const checkId = randomUUID();
    tx.insert('InstagramChecks', {
      UserId: userId,
      CheckId: checkId,
      CheckedAt: Spanner.COMMIT_TIMESTAMP,
      Input: input.slice(0, 300),
      Handle: handle,
      Result: 'pending',
    });
    await tx.commit();
    return { retryAfterSeconds: null, checkId };
  });
}

export async function profileRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireAuth };

  app.get('/api/me/profile', auth, async (req) => {
    const p = await readProfile(database, req.user!.userId);
    return {
      email: req.user!.email,
      address: p?.Country
        ? {
            name: p.RecipientName ?? '',
            line1: p.AddressLine1 ?? '',
            line2: p.AddressLine2 ?? '',
            city: p.City ?? '',
            region: p.Region ?? '',
            postalCode: p.PostalCode ?? '',
            country: p.Country,
          }
        : null,
      instagram:
        p?.InstagramHandle && p.InstagramStatus
          ? { handle: p.InstagramHandle, result: p.InstagramStatus, checkedAt: p.InstagramCheckedAt, current: !!p.InstagramFresh }
          : null,
    };
  });

  app.post<{ Body: { input: string } }>(
    '/api/me/instagram/check',
    {
      ...auth,
      schema: {
        body: {
          type: 'object',
          required: ['input'],
          additionalProperties: false,
          properties: { input: { type: 'string', maxLength: 300 } },
        },
      },
    },
    async (req, reply) => {
      const { input } = req.body;
      const userId = req.user!.userId;
      const cleaned = cleanInstagramHandle(input);
      if ('error' in cleaned) return reply.code(400).send({ error: cleaned.error });
      const { handle } = cleaned;

      const gate = await startCheck(userId, input, handle);
      if (gate.checkId === null) {
        return reply
          .code(429)
          .header('Retry-After', String(gate.retryAfterSeconds))
          .send({
            error: `Please wait ${gate.retryAfterSeconds} seconds before checking again.`,
            retryAfterSeconds: gate.retryAfterSeconds,
          });
      }

      const { result, strategy } = await checkInstagram(handle, req.log);
      const passed = result === 'public' || result === 'exists' || result === 'unknown';
      await database.runTransactionAsync(async (tx) => {
        tx.update('InstagramChecks', { UserId: userId, CheckId: gate.checkId, Result: result, Strategy: strategy });
        // A failed check clears the saved handle, so an earlier pass can't be used to join with a typo.
        tx.upsert('UserProfiles', {
          UserId: userId,
          InstagramHandle: passed ? handle : null,
          InstagramStatus: passed ? result : null,
          InstagramCheckedAt: passed ? Spanner.COMMIT_TIMESTAMP : null,
          InstagramStrategy: passed ? strategy : null,
          UpdatedAt: Spanner.COMMIT_TIMESTAMP,
        });
        await tx.commit();
      });
      return {
        input,
        handle,
        changed: handle !== input,
        result,
        retryAfterSeconds: config.instagram.minSecondsBetweenChecks,
      };
    },
  );
}
