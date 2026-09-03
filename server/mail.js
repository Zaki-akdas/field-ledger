/**
 * Day-end report email — sends the salesman's daily collection report
 * (PDF + Excel) to the office over SMTP. Configuration is environment-only:
 *
 *   SMTP_HOST, SMTP_PORT (587), SMTP_SECURE (true for 465),
 *   SMTP_USER, SMTP_PASS, OFFICE_EMAIL, MAIL_FROM (defaults to SMTP_USER)
 *
 * Nothing sends until those are set — isMailConfigured() is the gate, so an
 * unconfigured deploy just skips the email (the sales app still offers the
 * one-tap share sheet). nodemailer is only touched when a mail is composed.
 */
import nodemailer from 'nodemailer';

const env = (k) => process.env[k];

export function isMailConfigured() {
  return Boolean(env('SMTP_HOST') && env('SMTP_USER') && env('SMTP_PASS') && env('OFFICE_EMAIL'));
}

function transport({ stream = false } = {}) {
  if (stream) return nodemailer.createTransport({ streamTransport: true });
  return nodemailer.createTransport({
    host: env('SMTP_HOST'),
    port: Number(env('SMTP_PORT') || 587),
    secure: env('SMTP_SECURE') === 'true',
    auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') },
  });
}

const inr = (n) => Math.round(Number(n) || 0).toLocaleString('en-IN');

/** Build and send the day-end message. `stream` captures the raw RFC822
 *  message instead of delivering over SMTP — used by the regression probe. */
export async function composeDayReport({
  to, salesman, date, summary, attachments,
  from = env('MAIL_FROM') || env('SMTP_USER'),
  stream = false,
}) {
  const subject = `Collection report — ${salesman.code} · ${date}`;
  const text = [
    'Hi office,',
    '',
    `Here is the daily collection report for ${salesman.name} (${salesman.code}) for ${date}.`,
    '',
    `Invoices on the book: ${summary.count}`,
    `Billed:   ₹${inr(summary.billed)}`,
    `Collected: ₹${inr(summary.collected)}`,
    `Balance:  ₹${inr(summary.balance)}`,
    '',
    'The printable PDF and the Excel register are attached.',
    '— Field Ledger',
  ].join('\n');

  const t = transport({ stream });
  const info = await t.sendMail({
    from,
    to,
    subject,
    text,
    attachments: attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
  });

  if (stream && info.message) {
    const chunks = [];
    for await (const chunk of info.message) chunks.push(chunk);
    info.raw = Buffer.concat(chunks);
  }
  return info;
}

/** Gate used by the day-end route: returns { skipped } unless configured. */
export async function sendDayReportEmail(opts) {
  if (!isMailConfigured()) return { skipped: true };
  const info = await composeDayReport(opts);
  return { ok: true, messageId: info.messageId };
}
