import { describe, expect, it } from 'vitest';
import { classifySmtpFailure } from './smtp-mailer.service';

/*
 * The SMTP adapter's one piece of real logic: translating a relay's failure into the HTTP-shaped
 * status `MailSendError` promises, and that `decideRetry` reads (CONTRACT.md §26.3).
 *
 * WHY THIS IS THE ONLY THING TESTED HERE, AND WHY IT IS TESTED AT ALL. Everything else in the
 * adapter is passthrough into nodemailer. This is not: the two protocols disagree about which digit
 * means "try again". HTTP treats 5xx as transient and 4xx as final; SMTP is exactly the other way
 * round — 4xx is greylisting or a busy mailbox, 5xx is "no such user". Passing the SMTP code
 * through unchanged would invert the entire retry ladder: dead addresses hammered five times, and
 * recoverable failures abandoned on the first attempt.
 *
 * That inversion is invisible until a send fails in production, which is the worst time to find it,
 * and it is the kind of thing a later edit reintroduces by "simplifying" the mapping away.
 *
 * The error shapes below are nodemailer's: `code` for transport-level failures, `responseCode` for
 * a status the relay actually spoke.
 */

/** What the caller does with each translated status, per `decideRetry`. */
const RETRY = (status: number): boolean => status === 0 || status === 429 || status >= 500;

describe('classifySmtpFailure', () => {
  describe('the network never answered', () => {
    it.each(['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNREFUSED', 'ENOTFOUND'])(
      'treats %s as retryable',
      (code) => {
        const status = classifySmtpFailure({ code });

        expect(status).toBe(0);
        expect(RETRY(status)).toBe(true);
      },
    );
  });

  describe('SMTP 4xx is TRANSIENT — the opposite of HTTP', () => {
    it.each([
      [421, 'service not available, closing channel'],
      [450, 'mailbox unavailable, try again'],
      [451, 'local error in processing / greylisted'],
      [452, 'insufficient system storage'],
    ])('retries %i (%s)', (responseCode) => {
      const status = classifySmtpFailure({ responseCode });

      expect(status).toBe(503);
      expect(RETRY(status)).toBe(true);
    });
  });

  describe('SMTP 5xx is PERMANENT — also the opposite of HTTP', () => {
    it.each([
      [550, 'no such user'],
      [552, 'message too large'],
      [553, 'mailbox name not allowed'],
    ])('does not retry %i (%s)', (responseCode) => {
      const status = classifySmtpFailure({ responseCode });

      expect(status).toBe(400);
      expect(RETRY(status)).toBe(false);
    });
  });

  it('does not retry bad credentials, even though 535 is a 5xx some relays send transiently', () => {
    // A wrong App Password does not become right by waiting, and retrying it five times against
    // Gmail is a good way to have the account flagged.
    const status = classifySmtpFailure({ code: 'EAUTH', responseCode: 535 });

    expect(status).toBe(400);
    expect(RETRY(status)).toBe(false);
  });

  describe('anything it does not recognise', () => {
    /*
     * Retryable by choice, not by accident. The ladder is bounded by MAX_DELIVERY_ATTEMPTS, so
     * being wrong this way costs four wasted attempts; being wrong the other way loses the report
     * silently and forever.
     */
    it.each([
      ['an error with no code at all', new Error('something went wrong')],
      ['an unknown string code', { code: 'ESOMETHINGNEW' }],
      ['a nonsense response code', { responseCode: 199 }],
      ['null', null],
      ['undefined', undefined],
      ['a string', 'not an error object'],
    ])('treats %s as retryable', (_label, error) => {
      const status = classifySmtpFailure(error);

      expect(status).toBe(0);
      expect(RETRY(status)).toBe(true);
    });
  });

  it('prefers the transport code over the response code when both are present', () => {
    // A connection that dropped mid-conversation can carry a stale responseCode from an earlier
    // command. What went wrong is the socket, and the socket is retryable.
    expect(classifySmtpFailure({ code: 'ECONNRESET', responseCode: 550 })).toBe(0);
  });
});
