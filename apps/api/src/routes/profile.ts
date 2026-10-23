import { randomUUID } from 'node:crypto';
import { Timestamp, type Transaction } from '@google-cloud/firestore';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/plugin';
import { config } from '../config';
import { col, db, now, toIso } from '../db/firestore';
import type { ProfileDoc } from '../db/people';
import { checkInstagram, checkInstagramPost } from '../instagram';
import type { IgResult } from '../instagram/check';
import { cleanInstagramHandle } from '../instagram/handle';
import { parsePostLink } from '../instagram/post';
import type { Address } from '../profile/address';

/** Checks are kept this long (a TTL policy on ExpiresAt deletes them), then forgotten. */
const CHECK_KEEP_DAYS = 30;

type ProfileRow = Omit<ProfileDoc, 'UserId' | 'InstagramStatus' | 'InstagramCheckedAt' | 'InstagramStrategy'> & {
  InstagramStatus: 'public' | 'exists' | 'unknown' | null;
  InstagramCheckedAt: string | null;
  InstagramFresh: boolean;
};

/** The caller's saved sign-up info, or null. `InstagramFresh` is false once a passing check is too old to join with. */
export async function readProfile(tx: Transaction | undefined, userId: string): Promise<ProfileRow | null> {
  const ref = col.userProfiles.doc(userId);
  const snap = tx ? await tx.get(ref) : await ref.get();
  if (!snap.exists) return null;
  const p = snap.data() as ProfileDoc;
  const validMs = config.instagram.checkValidDays * 24 * 60 * 60 * 1000;
  return {
    RecipientName: p.RecipientName ?? null,
    RecipientFirstName: p.RecipientFirstName ?? null,
    RecipientLastName: p.RecipientLastName ?? null,
    Country: p.Country ?? null,
    AddressLine1: p.AddressLine1 ?? null,
    AddressLine2: p.AddressLine2 ?? null,
    City: p.City ?? null,
    Region: p.Region ?? null,
    PostalCode: p.PostalCode ?? null,
    InstagramHandle: p.InstagramHandle ?? null,
    InstagramPostUrl: p.InstagramPostUrl ?? null,
    InstagramStatus: (p.InstagramStatus as ProfileRow['InstagramStatus']) ?? null,
    InstagramCheckedAt: toIso(p.InstagramCheckedAt),
    InstagramFresh: !!p.InstagramCheckedAt && p.InstagramCheckedAt.toMillis() > Date.now() - validMs,
  };
}

/** The saved address as the API sends it. Profiles saved before first/last names have only the full name, so split it on the last space. */
export function addressView(p: Pick<ProfileDoc, 'RecipientName' | 'RecipientFirstName' | 'RecipientLastName' | 'AddressLine1' | 'AddressLine2' | 'City' | 'Region' | 'PostalCode' | 'Country'>) {
  const full = p.RecipientName ?? '';
  const cut = full.lastIndexOf(' ');
  return {
    firstName: p.RecipientFirstName ?? (cut < 0 ? full : full.slice(0, cut)),
    lastName: p.RecipientLastName ?? (cut < 0 ? '' : full.slice(cut + 1)),
    name: full,
    line1: p.AddressLine1 ?? '',
    line2: p.AddressLine2 ?? '',
    city: p.City ?? '',
    region: p.Region ?? '',
    postalCode: p.PostalCode ?? '',
    country: p.Country ?? '',
  };
}

export function addressColumns(a: Address) {
  return {
    RecipientName: a.name,
    RecipientFirstName: a.firstName,
    RecipientLastName: a.lastName,
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
async function startCheck(userId: string, input: string, handle: string | null) {
  const { minSecondsBetweenChecks, maxChecksPerHour } = config.instagram;
  return db.runTransaction(async (tx) => {
    const profileRef = col.userProfiles.doc(userId);
    const [checks] = await Promise.all([tx.get(col.instagramChecks.where('UserId', '==', userId)), tx.get(profileRef)]);
    const nowMs = Date.now();
    const times = checks.docs
      .map((d) => (d.get('CheckedAt') as Timestamp).toMillis())
      .filter((ms) => ms > nowMs - 60 * 60 * 1000);
    let wait = 0;
    if (times.length >= maxChecksPerHour) wait = 3600 - Math.floor((nowMs - Math.min(...times)) / 1000);
    else if (times.length > 0) {
      const sinceLastMs = nowMs - Math.max(...times);
      if (sinceLastMs < minSecondsBetweenChecks * 1000) {
        wait = Math.ceil((minSecondsBetweenChecks * 1000 - sinceLastMs) / 1000);
      }
    }
    if (wait > 0) return { retryAfterSeconds: Math.max(1, wait), checkId: null };

    const checkId = randomUUID();
    tx.create(col.instagramChecks.doc(checkId), {
      UserId: userId,
      CheckId: checkId,
      CheckedAt: now(),
      // For the TTL policy that deletes old checks.
      ExpiresAt: Timestamp.fromMillis(Date.now() + CHECK_KEEP_DAYS * 24 * 60 * 60 * 1000),
      Input: input.slice(0, 300),
      Handle: handle,
      Result: 'pending',
      Strategy: null,
    });
    // Writing the profile doc we read makes parallel checks by one person conflict, so one retries and sees the other.
    tx.set(profileRef, { UserId: userId, UpdatedAt: now() }, { merge: true });
    return { retryAfterSeconds: null, checkId };
  });
}

export async function profileRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireAuth };

  app.get('/api/me/profile', auth, async (req) => {
    const p = await readProfile(undefined, req.user!.userId);
    return {
      email: req.user!.email,
      address: p?.Country ? addressView(p) : null,
      instagram:
        p?.InstagramHandle && p.InstagramStatus
          ? {
              handle: p.InstagramHandle,
              postUrl: p.InstagramPostUrl,
              result: p.InstagramStatus,
              checkedAt: p.InstagramCheckedAt,
              current: !!p.InstagramFresh,
            }
          : null,
    };
  });

  // `input` is a link to one of the person's posts. If Instagram won't show us the post, the answer is
  // 'needs_handle', and the page asks for their name and sends it as `handle` with the same link.
  app.post<{ Body: { input: string; handle?: string } }>(
    '/api/me/instagram/check',
    {
      ...auth,
      schema: {
        body: {
          type: 'object',
          required: ['input'],
          additionalProperties: false,
          properties: { input: { type: 'string', maxLength: 300 }, handle: { type: 'string', maxLength: 300 } },
        },
      },
    },
    async (req, reply) => {
      const { input } = req.body;
      const userId = req.user!.userId;
      const post = parsePostLink(input);
      if ('error' in post) return reply.code(400).send({ error: post.error });
      let typed: string | null = null;
      if (req.body.handle !== undefined) {
        const cleaned = cleanInstagramHandle(req.body.handle);
        if ('error' in cleaned) return reply.code(400).send({ error: cleaned.error });
        typed = cleaned.handle;
      }

      const gate = await startCheck(userId, input, typed);
      if (gate.checkId === null) {
        return reply
          .code(429)
          .header('Retry-After', String(gate.retryAfterSeconds))
          .send({
            error: `Please wait ${gate.retryAfterSeconds} seconds before checking again.`,
            retryAfterSeconds: gate.retryAfterSeconds,
          });
      }

      const fromPost = await checkInstagramPost(post.url, req.log);
      let handle: string | null = fromPost.result === 'public' ? fromPost.handle : null;
      let result: IgResult | 'needs_handle' = fromPost.result;
      let strategy = fromPost.strategy && `post:${fromPost.strategy}`;
      if (fromPost.result === 'unknown') {
        if (typed) {
          ({ result, strategy } = await checkInstagram(typed, req.log));
          handle = typed;
        } else {
          result = 'needs_handle';
        }
      }

      const passed = result === 'public' || result === 'exists' || result === 'unknown';
      const batch = db.batch();
      batch.update(col.instagramChecks.doc(gate.checkId), { Handle: handle, Result: result, Strategy: strategy });
      // A failed check clears the saved handle, so an earlier pass can't be used to join with someone else's post.
      if (result !== 'needs_handle') {
        batch.set(
          col.userProfiles.doc(userId),
          {
            UserId: userId,
            InstagramHandle: passed ? handle : null,
            InstagramPostUrl: passed ? post.url : null,
            InstagramStatus: passed ? result : null,
            InstagramCheckedAt: passed ? now() : null,
            InstagramStrategy: passed ? strategy : null,
            UpdatedAt: now(),
          },
          { merge: true },
        );
      }
      await batch.commit();
      return {
        input,
        postUrl: post.url,
        handle,
        result,
        retryAfterSeconds: config.instagram.minSecondsBetweenChecks,
      };
    },
  );
}
