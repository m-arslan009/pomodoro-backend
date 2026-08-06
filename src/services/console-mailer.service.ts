import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Mailer, type MailMessage, type MailReceipt } from '../common/ports/mailer.port';

/*
 * The development `Mailer` — writes the message to the log and sends nothing.
 *
 * `docker-compose.yml` runs Postgres and nothing else, so there is no local inbox to point an SMTP
 * transport at. This is what stands in for one, and it is the reason the whole delivery path can be
 * exercised end to end — a real tick, real subscriptions, real periods, real PDF — without a
 * provider account and without the possibility of mailing a real person from a laptop.
 *
 * THE BODY IS PRINTED IN FULL, INCLUDING CONFIRMATION LINKS. That is the point: a developer needs to
 * click the link. It is also exactly why this adapter must never be selectable in production, which
 * `env.schema.ts` enforces rather than leaving to a convention — a confirmation token in a
 * production log is a credential in a log.
 */

@Injectable()
export class ConsoleMailer extends Mailer {
  private readonly logger = new Logger(ConsoleMailer.name);

  send(message: MailMessage): Promise<MailReceipt> {
    const attachments = (message.attachments ?? []).map(
      (attachment) => `${attachment.filename} (${attachment.content.byteLength} bytes)`,
    );

    this.logger.log(
      [
        '',
        '──────────────────────────────────────────── mail (not sent)',
        `To:      ${message.to}`,
        `Subject: ${message.subject}`,
        ...Object.entries(message.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
        ...(attachments.length > 0 ? [`Attached: ${attachments.join(', ')}`] : []),
        '',
        message.text,
        '────────────────────────────────────────────────────────────',
      ].join('\n'),
    );

    // A synthetic id, so the delivery ledger stores the same shape it would in production and the
    // webhook join is exercised by the same code rather than by a null-only path.
    return Promise.resolve({ messageId: `console-${randomUUID()}` });
  }
}
