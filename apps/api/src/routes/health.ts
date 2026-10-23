import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { col, now } from '../db/firestore';
import { mailer, sendMail } from '../email/mailer';

async function checkFirestore() {
  const started = Date.now();
  try {
    const ref = col.hello.doc(randomUUID());
    await ref.create({ Message: 'Hello from Sew Swap', CreatedAt: now() });
    const message = ((await ref.get()).data()?.Message as string | undefined) ?? null;
    await ref.delete();
    return { ok: true, roundTripMs: Date.now() - started, message };
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
    const [firestore, smtp] = await Promise.all([checkFirestore(), checkSmtp()]);
    const ok = firestore.ok && smtp.ok;
    reply.code(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'degraded', firestore, smtp };
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
