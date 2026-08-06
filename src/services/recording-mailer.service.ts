import { Injectable } from '@nestjs/common';
import { Mailer, type MailMessage, type MailReceipt } from '../common/ports/mailer.port';

/*
 * The test `Mailer` — keeps every message in memory and sends nothing.
 *
 * ADR-009 named this before it existed: *"the mailer sits behind an interface, so tests assert 'a
 * message was queued to X' without network."* This is that interface's third implementation, and
 * together with ConsoleMailer it is what makes the `Mailer` port pass ADR-020's test rather than
 * being a wrapper with an abstract class in front of it.
 *
 * Registered by tests, never by a module. Nothing in `report.module.ts` can select it, so there is
 * no configuration under which production silently stops sending mail.
 */

@Injectable()
export class RecordingMailer extends Mailer {
  private readonly messages: MailMessage[] = [];

  /**
   * The next send's outcome, when a test needs a failure.
   *
   * Set it to throw and the retry ladder (§26.3) becomes testable without a provider that can be
   * asked to return a 500 on demand.
   */
  failWith: Error | null = null;

  send(message: MailMessage): Promise<MailReceipt> {
    if (this.failWith) {
      const error = this.failWith;
      // One-shot, so a test can fail the first attempt and let the retry succeed — which is the
      // behaviour worth asserting, and it is unreachable if the failure is sticky.
      this.failWith = null;
      return Promise.reject(error);
    }

    this.messages.push(message);
    return Promise.resolve({ messageId: `recorded-${this.messages.length}` });
  }

  /** Everything sent so far, oldest first. A copy — a test cannot mutate the record it is reading. */
  get sent(): readonly MailMessage[] {
    return [...this.messages];
  }

  /** The most recent message, or undefined. The common assertion, spelled once. */
  get last(): MailMessage | undefined {
    return this.messages[this.messages.length - 1];
  }

  /** Every message sent to one address. */
  sentTo(address: string): readonly MailMessage[] {
    return this.messages.filter((message) => message.to === address);
  }

  reset(): void {
    this.messages.length = 0;
    this.failWith = null;
  }
}
