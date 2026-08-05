import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { CREDENTIAL_THROTTLE, REFRESH_THROTTLE } from '../common/constants/auth.constants';
import { CurrentAuth } from '../common/decorators/current-auth.decorator';
import type { DeviceContext } from '../common/types/auth-session.types';
import type { AuthContext, UserProfile } from '../common/types/user.types';
import { readCookie, refreshCookieOptions } from '../common/utils/cookies';
import type { Env } from '../config/env.schema';
import { OAUTH_PROVIDERS, type OAuthProvider } from '../domain/oauth';
import {
  type ChangePasswordDto,
  type LoginDto,
  type RegisterDto,
  changePasswordSchema,
  loginSchema,
  registerSchema,
} from '../dto/auth.dto';
import { JwtGuard } from '../guards/jwt.guard';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { AuthService, type AuthResult } from '../services/auth.service';

/*
 * HTTP only. Parses, delegates, writes the response — no rules live here. This and
 * `oauth.controller.ts` are the only two files in the application that read or write a cookie, and
 * both take the *attributes* from `common/utils/cookies.ts` rather than restating them, so the pair
 * cannot drift into setting one cookie the browser then refuses to send back.
 *
 * Every successful authentication answers with the same three body fields **and** a `Set-Cookie`
 * (ADR-008 rev. 3). The split is deliberate: the access token travels in the body because a script
 * must attach it to the next request, and the client is required to hold it in memory and never in
 * storage; the refresh token travels in an HttpOnly cookie precisely so that no script can reach
 * it, which is what makes it safe to be the long-lived half.
 */

interface AuthResponse {
  user: UserProfile;
  accessToken: string;
  /** Milliseconds until the access token expires, after which the client silently refreshes. */
  expiresIn: number;
}

function authBody(result: AuthResult): AuthResponse {
  return {
    user: result.profile,
    accessToken: result.accessToken,
    expiresIn: result.accessTokenExpiresIn,
  };
}

/** Forensic columns, and the only use this controller makes of the raw request. */
function deviceOf(request: Request): DeviceContext {
  const agent = request.headers['user-agent'];
  return {
    userAgent: typeof agent === 'string' ? agent.slice(0, 512) : null,
    ip: request.ip ?? null,
  };
}

@Controller('auth')
export class AuthController {
  private readonly cookieName: string;
  private readonly isProduction: boolean;
  private readonly oauthEnabled: boolean;

  constructor(
    private readonly auth: AuthService,
    config: ConfigService<Env, true>,
  ) {
    this.cookieName = config.get('SESSION_COOKIE_NAME', { infer: true });
    this.isProduction = config.get('NODE_ENV', { infer: true }) === 'production';
    this.oauthEnabled = config.get('OAUTH_ENABLED', { infer: true });
  }

  /** The presented refresh token, or null. The one place the cookie is read. */
  private presentedToken(request: Request): string | null {
    return readCookie(request.headers.cookie, this.cookieName);
  }

  /**
   * Write the rotated refresh token. `expires` rather than `maxAge` so the cookie's own lifetime
   * tracks the session row's idle window instead of being restated in two places that can drift.
   */
  private setSessionCookie(response: Response, result: AuthResult): void {
    response.cookie(this.cookieName, result.refresh.token, {
      ...refreshCookieOptions(this.isProduction),
      expires: result.refresh.expiresAt,
    });
  }

  /**
   * Drop the cookie. **Must use the same attributes it was set with** — a `path` mismatch leaves the
   * cookie in place and the browser keeps sending it, which reads as "logout did nothing".
   */
  private clearSessionCookie(response: Response): void {
    response.clearCookie(this.cookieName, refreshCookieOptions(this.isProduction));
  }

  /**
   * 201 with an access token: registering signs you in, which is what the sign-up form has
   * always implied. A taken email or username comes back as 409 with field errors.
   */
  @Post('register')
  @Throttle({ default: CREDENTIAL_THROTTLE })
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body(new ZodValidationPipe(registerSchema)) dto: RegisterDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponse> {
    const result = await this.auth.register(dto, deviceOf(request));
    this.setSessionCookie(response, result);
    return authBody(result);
  }

  /** Accepts an email or a username in one field; 401 for every failure, with one wording. */
  @Post('login')
  @Throttle({ default: CREDENTIAL_THROTTLE })
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponse> {
    const result = await this.auth.login(dto, deviceOf(request));
    this.setSessionCookie(response, result);
    return authBody(result);
  }

  /**
   * Renew an access token from the refresh cookie, rotating the cookie in the process.
   *
   * **Unguarded on purpose** (CONTRACT.md §4 preamble): the access token is precisely what has
   * expired by the time a client calls this, so requiring one would make the endpoint unable to do
   * its job. The cookie is the credential.
   *
   * `REFRESH_THROTTLE` rather than `CREDENTIAL_THROTTLE` — guessing a 32-byte CSPRNG token is not
   * the threat model, and 5/min is tight enough that a laptop waking with several tabs could trip
   * it. A 429 here is not a 401, so the client would read it as "not signed in" and eject a user
   * who was.
   *
   * Every failure clears the cookie on the way out, so a dead token is not presented again on the
   * next page load.
   */
  @Post('refresh')
  @Throttle({ default: REFRESH_THROTTLE })
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponse> {
    try {
      const result = await this.auth.refresh(this.presentedToken(request), deviceOf(request));
      this.setSessionCookie(response, result);
      return authBody(result);
    } catch (error) {
      this.clearSessionCookie(response);
      throw error;
    }
  }

  /**
   * Which sign-in methods this deployment offers.
   *
   * **Unguarded** (§4 preamble): the login page needs the answer before anyone is signed in. It
   * carries no user data, and returns an empty list when `OAUTH_ENABLED` is false — which is what
   * makes the rollout switch usable rather than a way to ship a button that 404s (§4.13).
   */
  @Get('providers')
  providers(): { providers: readonly OAuthProvider[] } {
    return { providers: this.oauthEnabled ? OAUTH_PROVIDERS : [] };
  }

  /** The profile of the bearer of the presented access token. */
  @Get('me')
  @UseGuards(JwtGuard)
  me(@CurrentAuth() auth: AuthContext): { user: UserProfile } {
    return { user: auth.profile };
  }

  /**
   * End the session the cookie names, and clear the cookie. This revokes for real (ADR-008 rev. 3).
   *
   * **Unguarded**, where it used to require a token. A guarded logout strands the cookie the moment
   * the access token expires: the user clicks "sign out", gets a 401, and the next page load
   * silently signs them back in from a session that was never revoked. The cookie is the credential
   * that is still present, so it is the one to authenticate with.
   *
   * **Always 204**, whether or not a session matched — answering differently would let an
   * unauthenticated caller probe which tokens are live. The access token the caller holds is not
   * revoked by this and cannot be; it expires within `JWT_ACCESS_TTL_MS`, and the client discards it
   * in the same action.
   *
   * Still deliberately no `logout-all`. `auth_sessions` now makes it one statement, but it was
   * removed rather than left advertising a guarantee it could not keep, and reinstating it is a
   * product decision (CONTRACT.md §21).
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logout(this.presentedToken(request));
    this.clearSessionCookie(response);
  }

  /**
   * Change the password, sign every other device out, and hand this one a fresh session.
   *
   * The caller gets a new access token *and* a rotated cookie, so the device that made the change is
   * the one device the change does not disrupt. Access tokens already issued elsewhere keep working
   * until they expire — `JwtGuard` reads no session row — but they cannot be renewed.
   */
  @Post('change-password')
  @UseGuards(JwtGuard)
  @Throttle({ default: CREDENTIAL_THROTTLE })
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(changePasswordSchema)) dto: ChangePasswordDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponse> {
    const result = await this.auth.changePassword(auth, dto, deviceOf(request));
    this.setSessionCookie(response, result);
    return authBody(result);
  }
}
