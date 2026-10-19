import { randomUUID } from 'node:crypto';
import { Spanner } from '@google-cloud/spanner';
import nodemailer from 'nodemailer';
import { config } from '../config';
import { database } from '../db/spanner';

export const mailer = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.port === 465,
  auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
});

export function sendMail(to: string, subject: string, text: string, html?: string) {
  return mailer.sendMail({ from: config.smtp.from, to, subject, text, html });
}

export type EmailKind = 'makers_published' | 'new_pairing' | 'confirm_reminder';

export type Email = { subject: string; text: string; html: string };

export type Recipient = { userId: string; email: string };

/**
 * Sends a notification and keeps a copy in EmailLog, so the person can read it again in the app.
 * The row is written first as 'sending', then marked 'sent' or 'failed'. Only 'sent' emails are shown
 * as sent. A row left at 'sending' (the server stopped mid-send) may have gone out, so it still
 * holds back repeat reminders rather than risk emailing someone twice.
 */
export async function sendUserMail(to: Recipient, kind: EmailKind, swapId: string | null, email: Email) {
  const key = { UserId: to.userId, EmailId: randomUUID() };
  const log = database.table('EmailLog');
  await log.insert({
    ...key,
    SentAt: Spanner.COMMIT_TIMESTAMP,
    Kind: kind,
    SwapId: swapId,
    Subject: email.subject,
    Body: email.text,
    Status: 'sending',
  });
  try {
    await sendMail(to.email, email.subject, email.text, email.html);
  } catch (err) {
    await log.update({ ...key, Status: 'failed' });
    throw err;
  }
  await log.update({ ...key, Status: 'sent' });
}

/**
 * Sends to everyone, a few at a time. Runs before the reply because Cloud Run throttles CPU
 * once a response is sent. A failed send is logged and counted, never thrown.
 */
export async function sendToMany(
  recipients: Recipient[],
  send: (r: Recipient) => Promise<void>,
  log: { error: (obj: object, msg: string) => void },
  concurrency = 5,
) {
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < recipients.length; i += concurrency) {
    const results = await Promise.allSettled(recipients.slice(i, i + concurrency).map(send));
    results.forEach((r, j) => {
      if (r.status === 'fulfilled') sent++;
      else {
        failed++;
        log.error({ err: r.reason, userId: recipients[i + j].userId }, 'Could not send email');
      }
    });
  }
  return { sent, failed };
}
