import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.schema';
import { GoogleOidcService } from './google-oidc.service';

/*
 * The only component that talks to Google.
 *
 * `fetch` is stubbed rather than reached: what is testable here is the *request we compose* and how
 * each shape of answer is interpreted. Whether Google's token endpoint behaves as documented is
 * Google's business, and asserting it would be a test of the internet.
 *
 * Two of the assertions below are security properties rather than behaviour. The authorization
 * request must ask for `access_type=online`, because the safest way to guarantee a provider refresh
 * token is never stored is to never be issued one; and a successful exchange must yield the ID token
 * *and nothing else*, so the access token that came with it has nowhere to be kept.
 */

interface OAuthEnv {
  OAUTH_ENABLED: boolean;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  APP_ORIGIN: string;
}

// Deliberately not `as const`: every test that varies one key needs the widened type.
const ENV: OAuthEnv = {
  OAUTH_ENABLED: true,
  GOOGLE_CLIENT_ID: 'evergrove-test.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  APP_ORIGIN: 'http://localhost:5173',
};

const AUTHORIZE_INPUT = {
  state: 'state-value',
  nonce: 'nonce-value',
  codeChallenge: 'challenge-value',
};

function makeService(overrides: Partial<OAuthEnv> = {}): GoogleOidcService {
  const env: OAuthEnv = { ...ENV, ...overrides };
  return new GoogleOidcService({
    get: (key: keyof OAuthEnv) => env[key],
  } as unknown as ConfigService<Env, true>);
}

/** A minimal stand-in for the parts of `Response` this service reads. */
function respondWith(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: () => Promise.resolve(body),
  };
}

/** The parts of the outgoing request these tests read. The body is always form-encoded. */
interface CapturedRequest {
  url: string;
  method?: string;
  body?: URLSearchParams;
  signal?: unknown;
}

describe('GoogleOidcService', () => {
  let fetchCalls: CapturedRequest[];

  beforeEach(() => {
    fetchCalls = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function capture(answer: () => Promise<unknown>) {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        fetchCalls.push({
          url,
          method: init.method,
          body: init.body as URLSearchParams,
          signal: init.signal,
        });
        return answer();
      }),
    );
  }

  const stubFetch = (answer: unknown) => capture(() => Promise.resolve(answer));
  const stubNetworkFailure = () => capture(() => Promise.reject(new Error('network down')));

  describe('isEnabled', () => {
    it('follows the rollout switch', () => {
      expect(makeService().isEnabled).toBe(true);
      expect(makeService({ OAUTH_ENABLED: false }).isEnabled).toBe(false);
    });
  });

  describe('appUrl', () => {
    it('builds against the configured origin', () => {
      expect(makeService().appUrl('/timer')).toBe('http://localhost:5173/timer');
    });

    it('tolerates a trailing slash in configuration', () => {
      // Otherwise a stray slash in `.env` produces `http://host//timer`, which some hosts treat as
      // a different path and Netlify's rewrites do not match.
      expect(makeService({ APP_ORIGIN: 'http://localhost:5173/' }).appUrl('/timer')).toBe(
        'http://localhost:5173/timer',
      );
    });
  });

  describe('buildAuthorizeUrl', () => {
    it('asks for an OIDC identity, not merely an authorization', () => {
      const url = new URL(makeService().buildAuthorizeUrl(AUTHORIZE_INPUT));

      expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      // `openid` is the difference between a token that authorises an API call and one that asserts
      // who somebody is — which is the whole reason this feature needs OIDC and not bare OAuth 2.0.
      expect(url.searchParams.get('scope')).toBe('openid email profile');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe(ENV.GOOGLE_CLIENT_ID);
    });

    it('carries the PKCE challenge and its method', () => {
      const url = new URL(makeService().buildAuthorizeUrl(AUTHORIZE_INPUT));

      expect(url.searchParams.get('code_challenge')).toBe('challenge-value');
      // `plain` would make PKCE decorative: anyone who intercepts the challenge would hold the
      // verifier too.
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    });

    it('carries the state and nonce that bind the round trip', () => {
      const url = new URL(makeService().buildAuthorizeUrl(AUTHORIZE_INPUT));

      expect(url.searchParams.get('state')).toBe('state-value');
      expect(url.searchParams.get('nonce')).toBe('nonce-value');
    });

    it('refuses a provider refresh token and always shows the account chooser', () => {
      const url = new URL(makeService().buildAuthorizeUrl(AUTHORIZE_INPUT));

      expect(url.searchParams.get('access_type')).toBe('online');
      // Silently reusing whichever Google account the browser is signed into is how someone links
      // the wrong account to their Evergrove profile.
      expect(url.searchParams.get('prompt')).toBe('select_account');
    });

    it('points the redirect at the app origin, not at this server', () => {
      const url = new URL(makeService().buildAuthorizeUrl(AUTHORIZE_INPUT));

      /*
       * Port 5173, the dev server — not 3000. `/api/*` is proxied through it, which keeps every
       * request same-origin and is the reason the session cookie needs none of ADR-008 rev. 3's
       * attributes relaxed. Google matches this string exactly against the Console registration.
       */
      expect(url.searchParams.get('redirect_uri')).toBe(
        'http://localhost:5173/api/v1/auth/oauth/google/callback',
      );
    });

    it('never puts the client secret in a URL the browser will follow', () => {
      const url = makeService().buildAuthorizeUrl(AUTHORIZE_INPUT);

      expect(url).not.toContain(ENV.GOOGLE_CLIENT_SECRET);
    });
  });

  describe('exchangeCode', () => {
    it('posts the code, the verifier and the client credentials, form-encoded', async () => {
      stubFetch(respondWith({ id_token: 'the-id-token', access_token: 'the-access-token' }));

      await makeService().exchangeCode('the-code', 'the-verifier');

      const [call] = fetchCalls;
      expect(call.url).toBe('https://oauth2.googleapis.com/token');
      expect(call.method).toBe('POST');

      expect(Object.fromEntries(call.body ?? new URLSearchParams())).toEqual({
        code: 'the-code',
        client_id: ENV.GOOGLE_CLIENT_ID,
        client_secret: ENV.GOOGLE_CLIENT_SECRET,
        redirect_uri: 'http://localhost:5173/api/v1/auth/oauth/google/callback',
        grant_type: 'authorization_code',
        // The half kept on this side for the whole flow, presented only here.
        code_verifier: 'the-verifier',
      });
    });

    it('bounds the request so a hung endpoint does not hold a connection open', async () => {
      stubFetch(respondWith({ id_token: 'the-id-token' }));

      await makeService().exchangeCode('the-code', 'the-verifier');

      expect(fetchCalls[0]?.signal).toBeInstanceOf(AbortSignal);
    });

    it('returns the ID token and discards everything else in the response', async () => {
      stubFetch(
        respondWith({
          id_token: 'the-id-token',
          access_token: 'the-access-token',
          refresh_token: 'a-refresh-token-we-did-not-ask-for',
        }),
      );

      const result = await makeService().exchangeCode('the-code', 'the-verifier');

      /*
       * The exhaustive equality is the assertion. No provider token is ever persisted, and the way
       * that is guaranteed is that none of them leaves this method — there is no field to carry one
       * and therefore nothing downstream can be tempted into storing it.
       */
      expect(result).toEqual({ ok: true, idToken: 'the-id-token' });
    });

    it('reports a refusal without carrying the provider’s explanation out', async () => {
      stubFetch(
        respondWith(
          { error: 'invalid_grant', error_description: 'Code was already redeemed' },
          {
            ok: false,
            status: 400,
          },
        ),
      );

      const result = await makeService().exchangeCode('spent-code', 'the-verifier');

      // A spent code is the common case: a reloaded or bookmarked callback URL. It must become a
      // friendly redirect, never a 500 — and never Google's own text, which echoes our parameters.
      expect(result).toEqual({ ok: false });
    });

    it('reports an unreachable endpoint rather than throwing', async () => {
      stubNetworkFailure();

      // A timeout or a DNS failure must become a friendly redirect, not an unhandled rejection on
      // a route that answers a browser navigation.
      await expect(makeService().exchangeCode('the-code', 'the-verifier')).resolves.toEqual({
        ok: false,
      });
    });

    it('reports a body that is not JSON', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() =>
          Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('html')) }),
        ),
      );

      await expect(makeService().exchangeCode('the-code', 'the-verifier')).resolves.toEqual({
        ok: false,
      });
    });

    it('reports a success that carried no ID token', async () => {
      stubFetch(respondWith({ access_token: 'the-access-token' }));

      // A 200 without an `id_token` means we asked for the wrong thing, or the scopes changed.
      // Treating it as success would leave the flow dereferencing undefined.
      await expect(makeService().exchangeCode('the-code', 'the-verifier')).resolves.toEqual({
        ok: false,
      });
    });
  });

  describe('validateIdToken', () => {
    const NOW = new Date('2026-08-05T09:00:00.000Z');

    function tokenFor(audience: string): string {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      return [
        encode({ alg: 'RS256' }),
        encode({
          iss: 'https://accounts.google.com',
          aud: audience,
          sub: 'google-subject-1',
          email: 'ada@evergrove.app',
          email_verified: true,
          nonce: 'nonce-value',
          iat: Math.floor(NOW.getTime() / 1000) - 30,
          exp: Math.floor(NOW.getTime() / 1000) + 3600,
        }),
        'signature-not-checked',
      ].join('.');
    }

    it('validates against this client, not against whatever the token names', () => {
      const service = makeService();

      expect(
        service.validateIdToken(tokenFor(ENV.GOOGLE_CLIENT_ID), 'nonce-value', NOW),
      ).toMatchObject({ sub: 'google-subject-1' });
      // Proves the configured client id is what reaches the validator: a token minted for another
      // Google application carries a perfectly good signature and must still be refused.
      expect(service.validateIdToken(tokenFor('someone-else'), 'nonce-value', NOW)).toBeNull();
    });
  });
});
