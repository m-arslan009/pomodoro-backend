import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { Mailer, type MailMessage, type MailReceipt } from '../common/ports/mailer.port';

/*
 * The production `Mailer` — Resend, over global `fetch`, with **no SDK**.
 *
 * That is the same choice ADR-008a made for the Google token exchange and for the same reason it
 * recorded: zero new production dependencies. Resend's send API is one HTTPS POST carrying JSON, so
 * an SDK would buy a typed wrapper around `fetch` at the cost of a dependency in the send path of a
 * feature whose whole risk is the send path.
 *
 * EVERYTHING PROVIDER-SPECIFIC STOPS HERE. Base64 attachment encoding, the header shape, the
 * bearer-token scheme, the id field's name — none of it is visible through the port, so swapping
 * providers is this file and nothing else (CONTRACT.md §23.0 A1).
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** Long enough for a large attachment on a slow link, short enough that a hung tick still ends. */
const SEND_TIMEOUT_MS = 20_000;

/** A rejected send, carrying the one thing the caller needs in order to decide about retrying. */
export class MailSendError extends Error {
  constructor(
    message: string,
    /**
     * The provider's HTTP status, or 0 when the network never answered.
     *
     * This is the whole basis of the retry ladder (§26.3): a 5xx or a 0 is worth trying again, a
     * 4xx is a rejected address or a malformed payload and retrying it just repeats it.
     */
    readonly status: number,
  ) {
    super(message);
    this.name = 'MailSendError';
  }
}

/** The subset of Resend's response this adapter reads. */
interface ResendResponse {
  id?: unknown;
}

@Injectable()
export class ResendMailer extends Mailer {
  private readonly logger = new Logger(ResendMailer.name);
  private readonly apiKey: string;
  private readonly from: string;

  constructor(config: ConfigService<Env, true>) {
    super();
    /*
     * Read once, at construction. `env.schema.ts` has already refused to boot without either of
     * these when MAIL_PROVIDER is `resend`, so the non-null assertions below are the schema's
     * guarantee restated — not an assumption this file is making on its own.
     */
    this.apiKey = config.get('RESEND_API_KEY', { infer: true })!;
    this.from = config.get('MAIL_FROM', { infer: true })!;
  }

  async send(message: MailMessage): Promise<MailReceipt> {
    const body = {
      from: this.from,
      to: [message.to],
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
              // (§26.4). Base64 is Resend's only attachment encoding.
              content: attachment.content.toString('base64'),
              ...(attachment.contentType === undefined
                ? {}
                : { content_type: attachment.contentType }),
            })),
          }),
    };

    let response: Response;
    try {
      response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch {
      // Status 0 — the network never answered, which is the most retryable failure there is.
      throw new MailSendError('The mail provider was unreachable.', 0);
    }

    if (!response.ok) {
      /*
       * Status only, never the body. A failed send echoes the request back, and the request
       * contains the recipient's address — §9.7 is the record of what happens when a credential or
       * a personal identifier rides into a log line because an error path was chatty.
       */
      this.logger.warn(`Resend refused a message (HTTP ${response.status}).`);
      throw new MailSendError(`The mail provider refused the message.`, response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      // Accepted, but unparseable. The message is gone either way, so this is a receipt without an
      // id rather than a failure — treating it as one would send the same report twice.
      this.logger.warn('Resend accepted a message but returned a body that was not JSON.');
      return { messageId: null };
    }

    const id = (payload as ResendResponse)?.id;
    return { messageId: typeof id === 'string' ? id : null };
  }
}
