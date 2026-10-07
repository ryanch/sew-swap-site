import nodemailer from 'nodemailer';
import { config } from '../config';

export const mailer = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.port === 465,
  auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
});

export function sendMail(to: string, subject: string, text: string, html?: string) {
  return mailer.sendMail({ from: config.smtp.from, to, subject, text, html });
}
