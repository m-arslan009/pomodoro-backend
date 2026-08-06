import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import type { Env } from '../config/env.schema';
import { Mailer, type MailMessage, type MailReceipt } from '../common/ports/mailer.port';
import { MailSendError } from './resend-mailer.service';

/*
 * The SMTP `Mailer` — a plain relay, used while a Resend sending domain is being verified.
 *
 * WHY THIS EXISTS AT ALL, GIVEN A1 CHOSE ONE PROVIDER. Resend will only send from a domain the
 * account has verified by DNS, and a `gmail.com` sender can never be one — so with no verified
 * domain there is no way to put a real report in a real inbox, and the whole delivery path stays
 * unexercised. SMTP is the transport that needs nothing but credentials.
 *
 * IT IS A DEVELOPMENT TRANSPORT, AND THE COSTS ARE REAL (ADR-009 as superseded 2026-08-06):
 *
 *   - **No delivery webhooks.** SMTP reports a bounce by mailing the sender, hours later, as prose.
 *     Everything in §25.6 — the bounce counter, the automatic disable on a hard bounce or a
 *     complaint — is Resend-only and is simply not running under this adapter.
 *   - **No provider message id.** `messageId` here is an RFC 5322 Message-ID this process minted,
 *     not a handle in anyone's dashboard. Nothing can join a webhook to it, because there are no
 *     webhooks to join.
 *   - **Gmail's relay caps out around 500 messages a day**, which is not a batch mailer.
 *
 * Revisit — and delete this file — when the Resend domain verifies.
 */

/** Long enough for a large attachment on a slow link, short enough that a hung tick still ends. */
const SEND_TIMEOUT_MS = 20_000;

/**
 * The failure codes nodemailer reports when the conversation never happened.
 *
 * Distinct from an SMTP status: nothing was refused, the connection was. Always worth retrying.
 */
const NETWORK_ERROR_CODES = new Set([
  'ECONNECTION',
  'ETIMEDOUT',
  'ESOCKET',
  'ECONNREFUSED',
  'ECONNRESET',
  'EDNS',
  'EHOSTUNREACH',
  'ENOTFOUND',
]);

@Injectable()
export class SmtpMailer extends Mailer {
  private readonly logger = new Logger(SmtpMailer.name);
  private readonly from: string;
  /*
   * Explicitly parameterised. A bare `Transporter` falls back to the `any` overload, which makes
   * `sendMail`'s result untyped — and the one field read from it below is the message id that gets
   * recorded in the delivery ledger.
   */
  private readonly transporter: Transporter<SMTPTransport.SentMessageInfo>;

  constructor(config: ConfigService<Env, true>) {
    super();
    /*
     * Read once, at construction. `env.schema.ts` has already refused to boot without any of these
     * when MAIL_PROVIDER is `smtp`, so the non-null assertions are the schema's guarantee restated
     * rather than an assumption this file is making on its own.
     */
    this.from = config.get('MAIL_FROM', { infer: true })!;
    const port = config.get('SMTP_PORT', { infer: true });

    this.transporter = createTransport({
      host: config.get('SMTP_HOST', { infer: true })!,
      port,
      // 465 is implicit TLS; 587 opens in the clear and upgrades via STARTTLS. Deriving it from the
      // port rather than adding a flag removes a way to configure an unencrypted session by accident.
      secure: port === 465,
      auth: {
        user: config.get('SMTP_USER', { infer: true })!,
        pass: config.get('SMTP_PASSWORD', { infer: true }),
      },
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS,
    });
  }

  async send(message: MailMessage): Promise<MailReceipt> {
    try {
      const info = await this.transporter.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html === undefined ? {} : { html: message.html }),
        ...(message.headers === undefined ? {} : { headers: message.headers }),
        ...(message.attachments === undefined || message.attachments.length === 0
          ? {}
          : {
              attachments: message.attachments.map((attachment) => ({
                filename: attachment.filename,
                // The PDF exists as a Buffer for exactly this long and is never written to disk
                // (§26.4). nodemailer takes the bytes directly and does its own encoding.
                content: attachment.content,
                ...(attachment.contentType === undefined
                  ? {}
                  : { contentType: attachment.contentType }),
              })),
            }),
      });

      return { messageId: typeof info.messageId === 'string' ? info.messageId : null };
    } catch (error: unknown) {
      const status = classifySmtpFailure(error);

      /*
       * Status only, never the error body. A rejected SMTP command echoes the envelope back, and
       * the envelope contains the recipient's address — §9.7 is this codebase's record of what
       * happens when a personal identifier rides into a log line because an error path was chatty.
       */
      this.logger.warn(`SMTP refused a message (translated status ${status}).`);
      throw new MailSendError('The mail relay refused the message.', status);
    }
  }
}

/**
 * Translate an SMTP failure into the HTTP-shaped status `MailSendError` promises.
 *
 * **THE TWO PROTOCOLS DISAGREE ABOUT WHICH DIGIT MEANS "TRY AGAIN", AND THIS IS THE WHOLE POINT OF
 * THIS FUNCTION.** `decideRetry` (domain/report.ts) reads an HTTP status, where 5xx is a server
 * having a bad day and 4xx is a request that will fail identically forever. SMTP is the other way
 * round: 4xx is greylisting or a busy mailbox — the canonical retry — and 5xx is "no such user",
 * which retrying just repeats five times.
 *
 * Passing `responseCode` through unchanged would therefore invert the ladder exactly: hammer dead
 * addresses, and abandon the failures that were about to succeed. So the SMTP code is translated
 * here, at the edge, and no SMTP number is ever visible to the retry policy.
 *
 * An unrecognised failure is reported as retryable, because the ladder is bounded by
 * MAX_DELIVERY_ATTEMPTS: the cost of being wrong that way is four wasted attempts, and the cost of
 * being wrong the other way is a report that silently never arrives.
 */
export function classifySmtpFailure(error: unknown): number {
  const code = readString(error, 'code');
  const responseCode = readNumber(error, 'responseCode');

  // Bad credentials. A wrong App Password will not become right by waiting, so this is terminal
  // even though 535 is a 5xx that some relays send transiently.
  if (code === 'EAUTH') return 400;

  if (code !== undefined && NETWORK_ERROR_CODES.has(code)) return 0;

  if (responseCode !== undefined) {
    if (responseCode >= 400 && responseCode < 500) return 503; // transient: retry
    if (responseCode >= 500) return 400; // permanent: do not retry
  }

  return 0;
}

function readString(error: unknown, key: string): string | undefined {
  const value = (error as Record<string, unknown> | null)?.[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(error: unknown, key: string): number | undefined {
  const value = (error as Record<string, unknown> | null)?.[key];
  return typeof value === 'number' ? value : undefined;
}
