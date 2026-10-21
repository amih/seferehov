import nodemailer from 'nodemailer';
import { config } from './config.js';

const transport = config.smtp.host
  ? nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    })
  : null;

export async function sendMail({ to, subject, text, replyTo }, log) {
  if (!transport) {
    log.info({ to, subject }, `mail (SMTP not configured):\n${text}`);
    return;
  }
  await transport.sendMail({ from: config.smtp.from, to, subject, text, ...(replyTo ? { replyTo } : {}) });
}
