import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { OAUTH_THROTTLE } from '../common/constants/auth.constants';
import { notFoundProblem } from '../common/errors/problem.exception';
import type { DeviceContext } from '../common/types/auth-session.types';
import {
  OAUTH_COOKIE_NAME,
  oauthCookieOptions,
  readCookie,
  refreshCookieOptions,
} from '../common/utils/cookies';
import type { Env } from '../config/env.schema';
import { isOAuthProvider } from '../domain/oauth';
import { oauthCallbackQuerySchema, oauthStartQuerySchema } from '../dto/oauth.dto';
import { GoogleOidcService } from '../services/google-oidc.service';
import { OAuthService } from '../services/oauth.service';
import { OAuthTransactionService } from '../services/oauth-transaction.service';
import type { AuthResult } from '../services/auth.service';

/*
 * The two halves of provider sign-in (ADR-008a, CONTRACT.md §4.11, §4.12).
 *
 * Both routes are browser navigations rather than API calls, and almost everything unusual about
 * this file follows from that one fact:
 *
 *  - **Neither is guarded.** No access token exists at either moment — the first is how a signed-out
 *    user starts, and the second is a request the *provider* caused the browser to make. The
 *    credential on the callback is the signed transaction cookie, exactly as `/auth/refresh` is
 *    unguarded because the refresh cookie is its credential (§4 preamble).
 *  - **Neither answers with a Problem Document on a flow failure.** A browser renders whatever it
 *    receives, so an RFC 9457 body would put raw JSON on the user's screen. Failures leave as a
 *    redirect carrying a code, and the SPA owns every word (§6, §4.12).
 *  - **`@Res()` is used without `passthrough`**, because these handlers write the response
 *    themselves rather than returning a body to be serialised.
 *
 * A 404 *is* still a Problem Document, and that is correct: an unknown provider or a disabled
 * feature means the route does not exist, which is a wrong URL rather than a failed sign-in.
 */

/** Where a failed attempt lands. The SPA reads `?oauth_error=` and owns the message. */
const FAILURE_PATH = '/login';

@Controller('auth/oauth')
export class OAuthController {
  private readonly sessionCookieName: string;
  private readonly isProduction: boolean;

  constructor(
    private readonly oauth: OAuthService,
    private readonly google: GoogleOidcService,
    private readonly transactions: OAuthTransactionService,
    config: ConfigService<Env, true>,
  ) {
    this.sessionCookieName = config.get('SESSION_COOKIE_NAME', { infer: true });
    this.isProduction = config.get('NODE_ENV', { infer: true }) === 'production';
  }

  /**
   * Begin sign-in: mint the transaction, set its cookie, and hand the browser to Google.
   *
   * The query is normalised rather than validated (`dto/oauth.dto.ts`): a bad `returnTo` becomes the
   * default and an unrecognised `tz` is dropped, because rejecting either would render a JSON error
   * into a navigation over a value the user never typed.
   */
  @Get(':provider/start')
  @Throttle({ default: OAUTH_THROTTLE })
  async start(
    @Param('provider') provider: string,
    @Query() rawQuery: unknown,
    @Res() response: Response,
  ): Promise<void> {
    this.assertProviderAvailable(provider);

    const query = oauthStartQuerySchema.parse(rawQuery ?? {});
    const started = await this.oauth.start(query);

    response.cookie(OAUTH_COOKIE_NAME, started.transactionToken, {
      ...oauthCookieOptions(this.isProduction),
      maxAge: this.transactions.lifetimeMs,
    });

    response.redirect(started.authorizeUrl);
  }

  /**
   * The provider's redirect target: validate the round trip, then either open a session or explain.
   *
   * The transaction cookie is cleared on every path, success and failure alike. A transaction is
   * single-use by definition, and leaving a spent one in place means the next attempt starts by
   * presenting a `state` that can no longer match.
   */
  @Get(':provider/callback')
  @Throttle({ default: OAUTH_THROTTLE })
  async callback(
    @Param('provider') provider: string,
    @Query() rawQuery: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    this.assertProviderAvailable(provider);

    const presented = readCookie(request.headers.cookie, OAUTH_COOKIE_NAME);
    this.clearTransactionCookie(response);

    const query = oauthCallbackQuerySchema.parse(rawQuery ?? {});
    const result = await this.oauth.handleCallback(presented, query, deviceOf(request));

    if (!result.ok) {
      response.redirect(this.google.appUrl(`${FAILURE_PATH}?oauth_error=${result.code}`));
      return;
    }

    // The identical cookie, attributes and rotation semantics as `POST /auth/login`. The session is
    // not a variant of one — it is the same object, opened by `AuthService.startSession`.
    this.setSessionCookie(response, result.auth);
    response.redirect(this.google.appUrl(result.returnTo));
  }

  /**
   * 404 for an unknown provider and for the whole feature being switched off.
   *
   * Not 403: as far as this API is concerned a disabled provider does not exist, and answering
   * "forbidden" would confirm the route is there and merely closed to the caller.
   */
  private assertProviderAvailable(provider: string): void {
    if (!isOAuthProvider(provider) || !this.google.isEnabled) {
      throw notFoundProblem('That sign-in provider is not available.');
    }
  }

  private setSessionCookie(response: Response, result: AuthResult): void {
    response.cookie(this.sessionCookieName, result.refresh.token, {
      ...refreshCookieOptions(this.isProduction),
      expires: result.refresh.expiresAt,
    });
  }

  /** Must use the attributes it was set with — a `path` mismatch silently leaves it in place. */
  private clearTransactionCookie(response: Response): void {
    response.clearCookie(OAUTH_COOKIE_NAME, oauthCookieOptions(this.isProduction));
  }
}

/** Forensic columns for the session row, matching `AuthController`'s. */
function deviceOf(request: Request): DeviceContext {
  const agent = request.headers['user-agent'];
  return {
    userAgent: typeof agent === 'string' ? agent.slice(0, 512) : null,
    ip: request.ip ?? null,
  };
}
