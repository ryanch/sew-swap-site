import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Spanner } from '@google-cloud/spanner';
import { database } from '../db/spanner';
import { mailer, sendMail } from '../email/mailer';

async function checkSpanner() {
  const started = Date.now();
  try {
    const id = randomUUID();
    await database.table('HelloMessages').insert({
      Id: id,
      Message: 'Hello from Sew Swap',
      CreatedAt: Spanner.COMMIT_TIMESTAMP,
    });
    const [rows] = await database.run({
      sql: 'SELECT Message FROM HelloMessages WHERE Id = @id',
      params: { id },
      json: true,
    });
    const row = rows[0] as { Message?: string } | undefined;
    return { ok: true, roundTripMs: Date.now() - started, message: row?.Message ?? null };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function checkSmtp() {
  try {
    await mailer.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function healthRoutes(app: FastifyInstance) {
  app.get('/api/health', async (_req, reply) => {
    const [spanner, smtp] = await Promise.all([checkSpanner(), checkSmtp()]);
    const ok = spanner.ok && smtp.ok;
    reply.code(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'degraded', spanner, smtp };
  });

  app.post('/api/hello-email', async () => {
    const info = await sendMail(
      'tester@sewswap.local',
      'Hello from Sew Swap',
      'If you can read this in Mailpit, email delivery works.',
    );
    return { sent: true, messageId: info.messageId };
  });
}
