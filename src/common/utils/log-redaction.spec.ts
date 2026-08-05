import { describe, expect, it } from 'vitest';
import { scrubRequestUrl } from './log-redaction';

/*
 * CONTRACT.md §9.7 — the authorization code must never reach a log.
 *
 * This exists because the first implementation of the rule was inline in `app.module.ts` and was
 * found to be leaking by reading a log file by hand, which is not a check anybody runs twice.
 *
 * Only the inbound half is testable here. The `Location` header is removed by pino's own `redact`
 * configuration, which has no seam to unit-test — the verification for that one is the end-to-end
 * log scan recorded in `backend/prompt.md`.
 */

describe('scrubRequestUrl', () => {
  it('removes the callback query, which carries a live authorization code', () => {
    expect(scrubRequestUrl('/api/v1/auth/oauth/google/callback?code=4/0AfLiveCode&state=abc')).toBe(
      '/api/v1/auth/oauth/google/callback?[redacted]',
    );
  });

  it('removes the start query too', () => {
    // Less obviously sensitive and still redacted: `tz` and `returnTo` are not secrets, but a rule
    // that reasons about which parameters are safe is a rule that eventually gets one wrong.
    expect(scrubRequestUrl('/api/v1/auth/oauth/google/start?returnTo=/timer&tz=Asia/Karachi')).toBe(
      '/api/v1/auth/oauth/google/start?[redacted]',
    );
  });

  it('keeps the path, because that is the whole diagnostic value of the line', () => {
    expect(scrubRequestUrl('/api/v1/auth/oauth/google/callback')).toBe(
      '/api/v1/auth/oauth/google/callback',
    );
  });

  it('leaves every other route alone', () => {
    // Cursors, limits and filters elsewhere are exactly what a log is for.
    expect(scrubRequestUrl('/api/v1/sessions?cursor=abc&limit=20')).toBe(
      '/api/v1/sessions?cursor=abc&limit=20',
    );
    expect(scrubRequestUrl('/api/v1/auth/login')).toBe('/api/v1/auth/login');
  });
});
