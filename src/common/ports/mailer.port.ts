/*
 * The third allowed port (ADR-020, amended 2026-08-06), beside `Clock` and `PasswordHasher`.
 *
 * ADR-020 refuses a port with one implementation and no plausible second. This one has three on the
 * day it ships — Resend, a console adapter for local development, and a recording fake for tests —
 * and the last two are the reason the whole outbound path is exercisable without a network or an
 * account with a mail provider.
 *
 * IT STAYS AT THE SMTP-SHAPED INTERSECTION, DELIBERATELY. Templates, tags, scheduled sends, message
 * streams and batch endpoints are all things some provider offers and others do not; modelling any
 * of them here would make "provider-neutral" false while looking like the opposite. Anything
 * provider-specific belongs inside the adapter (CONTRACT.md §23.0 A1).
 */

/** A file travelling with a message. Bytes only — nothing here is ever read from a path or a URL. */
export interface MailAttachment {
  readonly filename: string;
  readonly content: Buffer;
  /** RFC 2045 media type. Defaults to `application/octet-stream` at the adapter if omitted. */
  readonly contentType?: string;
}

/** One outbound message. */
export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  /**
   * Both bodies, always. A report whose figures exist only inside a PDF is unreadable to anyone who
   * cannot open one on the device they read mail on, and a transactional message with no text part
   * is a deliverability problem in its own right (CONTRACT.md §26.5).
   */
  readonly text: string;
  readonly html?: string;
  readonly attachments?: readonly MailAttachment[];
  /**
   * Extra headers the message class requires — `List-Unsubscribe` and its one-click companion on a
   * report, nothing on a confirmation. Kept as a bag rather than as named fields because the set is
   * decided by the message, not by the transport.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

/** What the provider said when it accepted the message. */
export interface MailReceipt {
  /**
   * The provider's own id, or null from an adapter that has none.
   *
   * It is the join key for delivery webhooks, which is the only reason it is returned at all: a
   * bounce event names a message, and without this there is no way to decide whose subscription it
   * belongs to.
   */
  readonly messageId: string | null;
}

/**
 * Sending is **accepting**, not delivering.
 *
 * A resolved promise means the provider took the message, which is a different claim from the
 * recipient receiving it — bounces arrive later, over a webhook, and are the only way to learn the
 * difference. Nothing downstream may treat a receipt as proof of delivery.
 *
 * A rejection carries the reason so the caller can decide whether it is worth retrying; the
 * classification itself is the caller's job, not this port's (§26.3).
 */
export abstract class Mailer {
  abstract send(message: MailMessage): Promise<MailReceipt>;
}
