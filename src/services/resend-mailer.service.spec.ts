import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { MailSendError, ResendMailer } from './resend-mailer.service';

/*
 * The Resend adapter, and specifically the one thing the rest of the feature reads off it: whether
 * a failed send is worth trying again (CONTRACT.md §26.3).
 *
 * The retry LADDER — backoff, the attempt ceiling, the terminal states — belongs to the worker,
 * which is phase R5 and does not exist yet. What exists is the classification this adapter produces,
 * and it is the input every one of those decisions is made from: a 5xx or a dead network is
 * retryable, a 4xx is a rejected address or a malformed payload and retrying it only repeats it.
 * Getting that backwards means either a report that silently never arrives, or the same report
 * mailed five times to an address that already refused it.
 *
 * `fetch` is stubbed rather than a server being started. There is nothing here worth testing about
 * HTTP itself — only about what this file does with each answer.
 */

const CONFIG = {
  get: (key: keyof Env) =>
    ({ RESEND_API_KEY: 'test-key', MAIL_FROM: 'Evergrove <reports@evergrove.test>' })[
      key as string
    ],
} as unknown as ConfigService<Env, true>;

/** A perfectly ordinary message. */
const MESSAGE = {
  to: 'someone@example.test',
  subject: 'Your weekly Evergrove report',
  text: 'Sessions: 12',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ResendMailer', () => {
  let mailer: ResendMailer;

  beforeEach(() => {
    mailer = new ResendMailer(CONFIG);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the provider message id, which is what a bounce webhook joins on', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { id: 'msg_01HZ' })));

    await expect(mailer.send(MESSAGE)).resolves.toEqual({ messageId: 'msg_01HZ' });
  });

  it('sends the message as JSON with a bearer key and the configured From', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: 'msg_1' }));
    vi.stubGlobal('fetch', fetchMock);

    await mailer.send({ ...MESSAGE, html: '<p>Sessions: 12</p>' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;

    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    expect(body.from).toBe('Evergrove <reports@evergrove.test>');
    expect(body.to).toEqual(['someone@example.test']);
    // Both parts travel. A message with no text part is a deliverability problem of its own (§26.5).
    expect(body.text).toBe('Sessions: 12');
    expect(body.html).toBe('<p>Sessions: 12</p>');
  });

  it('base64-encodes an attachment rather than writing it anywhere', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: 'msg_1' }));
    vi.stubGlobal('fetch', fetchMock);

    await mailer.send({
      ...MESSAGE,
      attachments: [
        {
          filename: 'evergrove-report-2026-07-27.pdf',
          content: Buffer.from('%PDF-1.7 pretend'),
          contentType: 'application/pdf',
        },
      ],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      attachments: { filename: string; content: string; content_type: string }[];
    };

    expect(body.attachments[0].filename).toBe('evergrove-report-2026-07-27.pdf');
    expect(body.attachments[0].content_type).toBe('application/pdf');
    expect(Buffer.from(body.attachments[0].content, 'base64').toString()).toBe('%PDF-1.7 pretend');
  });

  describe('failure classification — what the retry ladder reads', () => {
    it('reports status 0 when the network never answered', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

      const error = await mailer.send(MESSAGE).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MailSendError);
      expect((error as MailSendError).status).toBe(0);
    });

    it.each([500, 502, 503, 429])('reports %i, which the worker must retry', async (status) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(status, { message: 'nope' })));

      const error = (await mailer
        .send(MESSAGE)
        .catch((caught: unknown) => caught)) as MailSendError;
      expect(error).toBeInstanceOf(MailSendError);
      expect(error.status).toBe(status);
    });

    it.each([400, 403, 422])('reports %i, which the worker must not retry', async (status) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(status, { message: 'nope' })));

      const error = (await mailer
        .send(MESSAGE)
        .catch((caught: unknown) => caught)) as MailSendError;
      expect(error.status).toBe(status);
    });

    it('never puts the provider response body in the error', async () => {
      /*
       * A failed send echoes the request back, and the request contains the recipient's address.
       * §9.7 is this codebase's record of what happens when an error path is chatty with something
       * it should not be holding.
       */
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(jsonResponse(422, { message: 'someone@example.test is suppressed' })),
      );

      const error = (await mailer
        .send(MESSAGE)
        .catch((caught: unknown) => caught)) as MailSendError;
      expect(error.message).not.toContain('someone@example.test');
    });
  });

  it('treats an accepted-but-unparseable response as sent, not as a failure', async () => {
    /*
     * The message is gone either way. Reporting a failure here would make the worker retry a report
     * that has already been delivered, which is worse than losing the id — the id only costs the
     * webhook join.
     */
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>gateway</html>', { status: 200 })),
    );

    await expect(mailer.send(MESSAGE)).resolves.toEqual({ messageId: null });
  });
});
