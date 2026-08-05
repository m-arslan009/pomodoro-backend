import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../common/errors/problem.exception';
import type { Env } from '../config/env.schema';
import type { AuthResult } from '../services/auth.service';
import type { GoogleOidcService } from '../services/google-oidc.service';
import type { CallbackResult, OAuthService } from '../services/oauth.service';
import type { OAuthTransactionService } from '../services/oauth-transaction.service';
import { OAuthController } from './oauth.controller';

/*
 * The two redirect routes.
 *
 * The controller is instantiated directly rather than through a testing module: what is under test
 * is the code in these methods — which cookies are written, with which attributes, and where the
 * browser is finally sent — not that Nest can wire a constructor.
 *
 * Almost everything unusual here follows from these being *browser navigations* rather than API
 * calls. There is no response body to assert on; the observable behaviour is entirely
 * `Set-Cookie` and `Location`.
 */

const NOW = new Date('2026-08-05T09:00:00.000Z');
const APP = 'http://localhost:5173';

const ENV = { SESSION_COOKIE_NAME: 'evergrove_session', NODE_ENV: 'development' } as const;

function makeAuthResult(): AuthResult {
  return {
    profile: {
      id: 'user-1',
      email: 'ada@evergrove.app',
      username: 'Ada_L',
      firstName: 'Ada',
      lastName: 'Lovelace',
      timezone: 'Europe/London',
      emailVerified: true,
      avatarUpdatedAt: null,
      createdAt: NOW.toISOString(),
    },
    accessToken: 'access-token',
    accessTokenExpiresIn: 900_000,
    refresh: {
      token: 'refresh-token',
      expiresAt: new Date(NOW.getTime() + 604_800_000),
      absoluteExpiresAt: new Date(NOW.getTime() + 2_592_000_000),
    },
  } as unknown as AuthResult;
}

interface CookieWrite {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

function makeResponse() {
  const cookies: CookieWrite[] = [];
  const cleared: CookieWrite[] = [];
  const redirects: string[] = [];

  const response = {
    cookie: (name: string, value: string, options: Record<string, unknown>) => {
      cookies.push({ name, value, options });
      return response;
    },
    clearCookie: (name: string, options: Record<string, unknown>) => {
      cleared.push({ name, value: '', options });
      return response;
    },
    redirect: (url: string) => {
      redirects.push(url);
    },
  };

  return { response: response as unknown as Response, cookies, cleared, redirects };
}

function makeRequest(cookieHeader?: string): Request {
  return {
    headers: { cookie: cookieHeader, 'user-agent': 'vitest' },
    ip: '127.0.0.1',
  } as unknown as Request;
}

describe('OAuthController', () => {
  let startResult: { authorizeUrl: string; transactionToken: string };
  let callbackResult: CallbackResult;
  let callbackArgs: Array<{ presented: string | null; query: Record<string, unknown> }>;
  let startArgs: Array<{ returnTo: string; timezone: string | null }>;
  let enabled: boolean;

  let controller: OAuthController;

  beforeEach(() => {
    enabled = true;
    startResult = {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=abc',
      transactionToken: 'signed-transaction',
    };
    callbackResult = { ok: true, auth: makeAuthResult(), returnTo: '/timer' };
    callbackArgs = [];
    startArgs = [];

    const oauth = {
      start: vi.fn((query: { returnTo: string; timezone: string | null }) => {
        startArgs.push(query);
        return Promise.resolve(startResult);
      }),
      handleCallback: vi.fn((presented: string | null, query: Record<string, unknown>) => {
        callbackArgs.push({ presented, query });
        return Promise.resolve(callbackResult);
      }),
    } as unknown as OAuthService;

    const google = {
      get isEnabled() {
        return enabled;
      },
      appUrl: (path: string) => `${APP}${path}`,
    } as unknown as GoogleOidcService;

    const transactions = { lifetimeMs: 600_000 } as unknown as OAuthTransactionService;

    const config = { get: (key: keyof typeof ENV) => ENV[key] } as unknown as ConfigService<
      Env,
      true
    >;

    controller = new OAuthController(oauth, google, transactions, config);
  });

  describe('availability', () => {
    it('answers 404 for a provider that does not exist', async () => {
      const { response } = makeResponse();

      const error = (await controller
        .start('github', {}, response)
        .catch((caught: unknown) => caught)) as ProblemException;

      expect(error).toBeInstanceOf(ProblemException);
      expect(error.problem.status).toBe(404);
    });

    it('answers 404 rather than 403 when the feature is switched off', async () => {
      enabled = false;
      const { response } = makeResponse();

      const error = (await controller
        .start('google', {}, response)
        .catch((caught: unknown) => caught)) as ProblemException;

      /*
       * As far as this API is concerned a disabled provider does not exist. Answering "forbidden"
       * would confirm the route is there and merely closed, which is a deployment detail an
       * unauthenticated caller has no business learning.
       */
      expect(error.problem.status).toBe(404);
    });

    it('guards the callback the same way', async () => {
      enabled = false;
      const { response } = makeResponse();

      const error = (await controller
        .callback('google', {}, makeRequest(), response)
        .catch((caught: unknown) => caught)) as ProblemException;

      // A Problem Document is correct *here*, unlike a flow failure: this is a URL that names
      // nothing, not a sign-in that went wrong.
      expect(error.problem.status).toBe(404);
    });
  });

  describe('start', () => {
    it('sets the transaction cookie and hands the browser to the provider', async () => {
      const { response, cookies, redirects } = makeResponse();

      await controller.start('google', { returnTo: '/history' }, response);

      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toMatchObject({
        name: 'evergrove_oauth',
        value: 'signed-transaction',
      });
      expect(redirects).toEqual([startResult.authorizeUrl]);
    });

    it('scopes the transaction cookie so it rides the callback and nothing else', async () => {
      const { response, cookies } = makeResponse();

      await controller.start('google', {}, response);

      expect(cookies[0]?.options).toMatchObject({
        httpOnly: true,
        /*
         * `lax` is load-bearing and `strict` would be a silent, total failure. The provider's
         * callback arrives as a cross-site *top-level GET navigation*: `Lax` sends the cookie on
         * exactly that, `Strict` withholds it, and every sign-in would then fail with a state
         * mismatch and nothing in any log explaining why.
         */
        sameSite: 'lax',
        path: '/api/v1/auth/oauth',
        // Follows the environment: WebKit refuses to store `Secure` cookies on http://localhost and
        // fails by never storing them at all.
        secure: false,
        maxAge: 600_000,
      });
    });

    it('normalises the landing page before it reaches the flow', async () => {
      const { response } = makeResponse();

      await controller.start('google', { returnTo: 'https://evil.test/harvest' }, response);

      // The DTO reduces anything not allow-listed to the default, so no caller-supplied value
      // survives far enough to become a `Location` header.
      expect(startArgs[0]?.returnTo).toBe('/timer');
    });

    it('passes a usable browser zone through and drops an unusable one', async () => {
      const { response } = makeResponse();

      await controller.start('google', { tz: 'Asia/Tokyo' }, response);
      await controller.start('google', { tz: 'Mars/Olympus_Mons' }, response);

      expect(startArgs[0]?.timezone).toBe('Asia/Tokyo');
      // Dropped rather than rejected: it is a convenience the browser volunteered, and refusing the
      // whole sign-in over it would trade a working account with a UTC default for no account.
      expect(startArgs[1]?.timezone).toBeNull();
    });
  });

  describe('callback', () => {
    it('presents the transaction cookie to the flow', async () => {
      const { response } = makeResponse();

      await controller.callback(
        'google',
        { code: 'the-code', state: 'the-state' },
        makeRequest('evergrove_oauth=signed-transaction'),
        response,
      );

      expect(callbackArgs[0]?.presented).toBe('signed-transaction');
      expect(callbackArgs[0]?.query).toEqual({
        code: 'the-code',
        state: 'the-state',
        error: null,
      });
    });

    it('reports an absent cookie as absent rather than as an empty string', async () => {
      const { response } = makeResponse();

      await controller.callback('google', {}, makeRequest(), response);

      expect(callbackArgs[0]?.presented).toBeNull();
    });

    it('opens the session and lands the browser on the requested page', async () => {
      const { response, cookies, redirects } = makeResponse();

      await controller.callback('google', {}, makeRequest('evergrove_oauth=t'), response);

      const session = cookies.find((entry) => entry.name === 'evergrove_session');
      expect(session?.value).toBe('refresh-token');
      /*
       * The identical attributes `POST /auth/login` writes — the path in particular, because a
       * mismatch here would produce a cookie the browser never sends back to `/auth/refresh`, and
       * the user would appear signed in until the first reload.
       */
      expect(session?.options).toMatchObject({
        httpOnly: true,
        sameSite: 'lax',
        path: '/api/v1/auth',
      });
      expect(redirects).toEqual([`${APP}/timer`]);
    });

    it('clears the transaction cookie on the way out of a success', async () => {
      const { response, cleared } = makeResponse();

      await controller.callback('google', {}, makeRequest('evergrove_oauth=t'), response);

      expect(cleared).toHaveLength(1);
      expect(cleared[0]?.name).toBe('evergrove_oauth');
      /*
       * Cleared with the attributes it was set with. A `path` mismatch leaves the cookie in place,
       * the browser keeps presenting it, and the next attempt starts by sending a `state` that can
       * no longer match — a failure that looks like the flow being broken rather than a stale cookie.
       */
      expect(cleared[0]?.options).toMatchObject({ path: '/api/v1/auth/oauth', httpOnly: true });
    });

    it('clears the transaction cookie on a failure too', async () => {
      callbackResult = { ok: false, code: 'access_denied' };
      const { response, cleared } = makeResponse();

      await controller.callback('google', {}, makeRequest('evergrove_oauth=t'), response);

      // A transaction is single-use whether or not it succeeded.
      expect(cleared[0]?.name).toBe('evergrove_oauth');
    });

    it('sends a failure back to the sign-in page carrying only a code', async () => {
      callbackResult = { ok: false, code: 'provider_unavailable' };
      const { response, cookies, redirects } = makeResponse();

      await controller.callback('google', {}, makeRequest('evergrove_oauth=t'), response);

      expect(redirects).toEqual([`${APP}/login?oauth_error=provider_unavailable`]);
      /*
       * No session cookie on a failed sign-in — the obvious thing to get wrong when both branches
       * write to the same response object.
       */
      expect(cookies.find((entry) => entry.name === 'evergrove_session')).toBeUndefined();
    });

    it('never answers a flow failure with a problem document', async () => {
      callbackResult = { ok: false, code: 'email_unverified' };
      const { response, redirects } = makeResponse();

      // A browser renders whatever it receives. An RFC 9457 body here would put raw JSON on the
      // user's screen, which is why §4.12 makes this the one route that redirects instead.
      await expect(
        controller.callback('google', {}, makeRequest('evergrove_oauth=t'), response),
      ).resolves.toBeUndefined();
      expect(redirects[0]).toContain('oauth_error=email_unverified');
    });

    it('ignores a provider error description it was not asked for', async () => {
      const { response } = makeResponse();

      await controller.callback(
        'google',
        { error: 'access_denied', error_description: '<script>alert(1)</script>' },
        makeRequest(),
        response,
      );

      /*
       * `error_description` is attacker-influencable text arriving on an unauthenticated route, and
       * the DTO has no field for it. Asserting the parsed query is exhaustive is what stops it being
       * added back as a convenience.
       */
      expect(callbackArgs[0]?.query).toEqual({
        code: null,
        state: null,
        error: 'access_denied',
      });
    });

    it('treats a repeated query parameter as absent', async () => {
      const { response } = makeResponse();

      // Express parses `?code=a&code=b` into an array. A schema of `z.string()` would be describing
      // a type the runtime does not guarantee, so anything that is not a plain string is dropped.
      await controller.callback(
        'google',
        { code: ['a', 'b'], state: 'the-state' },
        makeRequest(),
        response,
      );

      expect(callbackArgs[0]?.query).toMatchObject({ code: null, state: 'the-state' });
    });
  });
});
