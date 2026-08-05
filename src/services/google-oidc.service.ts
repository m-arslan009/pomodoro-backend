import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { type IdTokenClaims, validateIdTokenClaims } from '../domain/oauth';

/*
 * Everything this application knows about talking to Google (ADR-008a).
 *
 * Two network-facing jobs and nothing else: build the URL the browser is redirected to, and trade
 * an authorization code for an ID token. Deciding *who the resulting person is* belongs to
 * `OAuthService`, and deciding whether a token's claims are believable belongs to `domain/oauth.ts`.
 *
 * No `openid-client`, no `jose`, no Passport strategy. Node's global `fetch` makes the one call, and
 * the ID token needs no signature verification because it arrives over that call — see
 * `decodeJwtPayload` for why, and for the boundary that reasoning must not be pushed past.
 */

/*
 * Hard-coded rather than read from Google's discovery document.
 *
 * Discovery is the more correct answer in general, and it costs a fetch at boot, a cache, and a
 * decision about what to do when it fails while the app is starting. These two URLs have been
 * stable for a decade and are pinned in Google's own documentation. Revisit when a second provider
 * is added: discovery earns its keep the moment there is more than one set of endpoints to track.
 */
const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** The callback path, which must match the Google Cloud Console registration byte for byte. */
const CALLBACK_PATH = '/api/v1/auth/oauth/google/callback';

/**
 * Google refuses to answer a token request in a reasonable time roughly never, but "roughly never"
 * without a timeout still means one hung request holds a connection until the socket dies.
 */
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

export interface AuthorizeUrlInput {
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
}

export type CodeExchangeResult =
  | { readonly ok: true; readonly idToken: string }
  /** The exchange failed. Deliberately carries no detail — see `exchangeCode`. */
  | { readonly ok: false };

@Injectable()
export class GoogleOidcService {
  private readonly logger = new Logger(GoogleOidcService.name);

  private readonly enabled: boolean;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly appOrigin: string;

  constructor(config: ConfigService<Env, true>) {
    this.enabled = config.get('OAUTH_ENABLED', { infer: true });
    // Guaranteed non-empty whenever `enabled` is true: the env schema's superRefine refuses to boot
    // otherwise, so these defaults are unreachable rather than merely unlikely.
    this.clientId = config.get('GOOGLE_CLIENT_ID', { infer: true }) ?? '';
    this.clientSecret = config.get('GOOGLE_CLIENT_SECRET', { infer: true }) ?? '';
    this.appOrigin = (config.get('APP_ORIGIN', { infer: true }) ?? '').replace(/\/+$/, '');
  }

  /** Whether Google sign-in is configured at all. Drives `GET /auth/providers` and both 404s. */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Where the browser is finally sent. Built from configuration, never from a request header. */
  appUrl(path: string): string {
    return `${this.appOrigin}${path}`;
  }

  /**
   * The `redirect_uri`, which Google matches as an exact string.
   *
   * It points at the *app* origin rather than at this server, because the SPA's dev proxy and the
   * production rewrite both forward `/api/*` here. Everything therefore stays same-origin, which is
   * what lets the session cookie keep the attributes ADR-008 rev. 3 chose for it.
   */
  private redirectUri(): string {
    return `${this.appOrigin}${CALLBACK_PATH}`;
  }

  buildAuthorizeUrl(input: AuthorizeUrlInput): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      // `openid` is what makes this OIDC rather than bare OAuth: it is the difference between a
      // token that authorises an API call and one that asserts an identity.
      scope: 'openid email profile',
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      // Always show the chooser. Silently reusing whichever Google account the browser happens to
      // be signed into is how someone links the wrong account to their Evergrove profile.
      prompt: 'select_account',
      /*
       * No refresh token, on purpose. We call no Google API on the user's behalf, so a provider
       * refresh token would be a long-lived credential stored for no reason — and the safest way to
       * guarantee one is never persisted is to never be issued one.
       */
      access_type: 'online',
    });

    return `${GOOGLE_AUTHORIZATION_ENDPOINT}?${params.toString()}`;
  }

  /**
   * Trade the authorization code for an ID token.
   *
   * The result carries no failure detail, and that is deliberate at two levels. Google's own
   * `error_description` is attacker-influencable text, and every outcome here becomes the same
   * user-visible redirect anyway — a spent code, a mismatched `redirect_uri`, a revoked client and a
   * network timeout are all "that did not work, try again" to the person waiting.
   *
   * **Nothing in this method may log its inputs.** `code` is a live credential until it is redeemed
   * and `codeVerifier` is the secret that redeems it; the log line that would help most while
   * debugging is exactly the one that must not exist (CONTRACT.md §9.7).
   */
  async exchangeCode(code: string, codeVerifier: string): Promise<CodeExchangeResult> {
    const body = new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri(),
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    });

    let response: Response;
    try {
      response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
    } catch {
      this.logger.warn('Google token endpoint unreachable.');
      return { ok: false };
    }

    if (!response.ok) {
      // Status only. The body of a failed token response echoes request parameters back.
      this.logger.warn(`Google token endpoint refused the exchange (HTTP ${response.status}).`);
      return { ok: false };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      this.logger.warn('Google token endpoint returned a body that was not JSON.');
      return { ok: false };
    }

    const idToken =
      typeof payload === 'object' && payload !== null && 'id_token' in payload
        ? (payload as { id_token?: unknown }).id_token
        : undefined;

    if (typeof idToken !== 'string' || idToken === '') {
      this.logger.warn('Google token response carried no id_token.');
      return { ok: false };
    }

    /*
     * The response also carries an `access_token`, and it is discarded here with the rest of the
     * object. We requested no API scopes, so it grants nothing we want; keeping it would create a
     * provider credential to store, rotate, encrypt and revoke, for no capability at all.
     */
    return { ok: true, idToken };
  }

  /** Validate the token's claims against this client and this request. Null on any failure. */
  validateIdToken(idToken: string, nonce: string, now: Date): IdTokenClaims | null {
    return validateIdTokenClaims(idToken, { audience: this.clientId, nonce, now });
  }
}
