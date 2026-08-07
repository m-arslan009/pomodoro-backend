import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../common/ports/clock.port';
import type { DeviceContext } from '../common/types/auth-session.types';
import type { IdTokenClaims, OAuthErrorCode } from '../common/types/oauth.types';
import type { UserRecord } from '../common/types/user.types';
import { normalizeUsername, usernameKey } from '../domain/identifier';
import {
  USERNAME_ATTEMPT_LIMIT,
  createPkcePair,
  deriveNames,
  deriveUsernameCandidate,
  randomUrlToken,
  resolveReturnTo,
} from '../domain/oauth';
import { DEFAULT_TIMEZONE } from '../domain/timezone';
import type { OAuthCallbackQuery, OAuthStartQuery } from '../dto/oauth.dto';
import { AuthIdentityRepository } from '../repositories/auth-identity.repository';
import { UserRepository } from '../repositories/user.repository';
import { AuthService, type AuthResult } from './auth.service';
import { GoogleOidcService } from './google-oidc.service';
import { OAuthTransactionService } from './oauth-transaction.service';

/*
 * The provider sign-in flow, end to end (ADR-008a, CONTRACT.md §4.11, §4.12, §4.12.1).
 *
 * Owns the *sequence* and nothing else: token validity is `domain/oauth.ts`, the network is
 * `GoogleOidcService`, persistence is the repositories, and — the point of the whole design — the
 * session is `AuthService.startSession`, exactly the one the password path uses. Nothing here mints
 * a credential, sets a cookie, or knows what a `Set-Cookie` is.
 *
 * The provider is Google throughout. It is named as a constant rather than parameterised because a
 * second provider is not a configuration change: branch 3b-ii below decides whether to hand an
 * existing account to whoever the provider says owns an address, and that decision has to be made
 * again, per provider, by a person.
 */

const PROVIDER = 'google' as const;

/**
 * The result of resolving validated claims to an account, before it becomes a session.
 *
 * `raced` is not a failure. It means another request created the same account or the same identity
 * between our lookup and our insert, so the correct response is to run the algorithm again — the
 * second pass finds what the first one was in the middle of creating.
 */
type Resolution =
  | { readonly kind: 'user'; readonly user: UserRecord }
  | { readonly kind: 'raced' }
  | { readonly kind: 'failed'; readonly code: OAuthErrorCode };

export interface StartedAuthorization {
  readonly authorizeUrl: string;
  /** The signed transaction, for the controller to put in the `evergrove_oauth` cookie. */
  readonly transactionToken: string;
}

export type CallbackResult =
  | { readonly ok: true; readonly auth: AuthResult; readonly returnTo: string }
  | { readonly ok: false; readonly code: OAuthErrorCode };

@Injectable()
export class OAuthService {
  private readonly logger = new Logger(OAuthService.name);

  constructor(
    private readonly users: UserRepository,
    private readonly identities: AuthIdentityRepository,
    private readonly google: GoogleOidcService,
    private readonly transactions: OAuthTransactionService,
    private readonly auth: AuthService,
    private readonly clock: Clock,
  ) {}

  /** Build the authorization request and the signed transaction that will validate its return. */
  async start(query: OAuthStartQuery): Promise<StartedAuthorization> {
    const state = randomUrlToken();
    const nonce = randomUrlToken();
    const pkce = createPkcePair();

    const transactionToken = await this.transactions.issue({
      state,
      nonce,
      // The verifier stays on this side for the entire flow. Only its SHA-256 goes to Google.
      codeVerifier: pkce.verifier,
      returnTo: query.returnTo,
      timezone: query.timezone,
    });

    return {
      authorizeUrl: this.google.buildAuthorizeUrl({ state, nonce, codeChallenge: pkce.challenge }),
      transactionToken,
    };
  }

  /**
   * Handle the provider's redirect: validate the round trip, resolve the account, open a session.
   *
   * Every failure path returns a code rather than throwing. The caller is answering a browser
   * navigation, so there is no error response to render — only a redirect — and an exception
   * escaping here would become a blank page instead of a message the user can act on.
   */
  async handleCallback(
    transactionToken: string | null,
    query: OAuthCallbackQuery,
    device: DeviceContext,
  ): Promise<CallbackResult> {
    /*
     * The provider reporting its own failure. Only `access_denied` — the user declining at the
     * consent screen — is distinguished; every other provider error is an operator problem the user
     * can do nothing about, and telling them which would describe our configuration to a stranger.
     */
    if (query.error !== null) {
      return {
        ok: false,
        code: query.error === 'access_denied' ? 'access_denied' : 'invalid_request',
      };
    }

    if (transactionToken === null) return { ok: false, code: 'invalid_request' };

    const transaction = await this.transactions.verify(transactionToken);
    if (transaction === null) return { ok: false, code: 'invalid_request' };

    /*
     * The CSRF check. `state` was signed into a cookie the client cannot forge and echoed back by
     * the provider; requiring the two to agree is what stops an attacker completing *their*
     * authorization inside a victim's browser and binding their Google account to it.
     */
    if (query.state === null || query.state !== transaction.state) {
      return { ok: false, code: 'invalid_request' };
    }

    if (query.code === null) return { ok: false, code: 'invalid_request' };

    const exchange = await this.google.exchangeCode(query.code, transaction.codeVerifier);
    if (!exchange.ok) return { ok: false, code: 'provider_unavailable' };

    const claims = this.google.validateIdToken(
      exchange.idToken,
      transaction.nonce,
      this.clock.now(),
    );
    if (claims === null) return { ok: false, code: 'invalid_request' };

    /*
     * Step 0 of §4.12.1, and it runs before anything can create or link. Branch 3b-ii below hands an
     * existing Evergrove account to whoever proved control of a matching address at Google — which
     * is only sound because this line already refused every address Google did not verify.
     */
    if (!claims.emailVerified) return { ok: false, code: 'email_unverified' };

    const resolution = await this.resolve(claims, transaction.timezone);
    if (resolution.kind !== 'user') {
      return {
        ok: false,
        code: resolution.kind === 'failed' ? resolution.code : 'invalid_request',
      };
    }

    /*
     * The session opens first because the landing page depends on it. Where a provider sign-in ends
     * up is decided from the authenticated profile — an admin lands on the panel, everyone else on
     * the Timer — and that profile does not exist until this line has run. It is the same account
     * object the password flow returns, read the same way, so the two cannot disagree about where
     * signing in leads.
     */
    const auth = await this.auth.startSession(resolution.user, device);

    return {
      ok: true,
      // Re-checked rather than trusted. The cookie is signed, so this cannot have been tampered
      // with — but an allow-list that shrinks between issue and callback would otherwise let a
      // ten-minute-old value through a rule that no longer permits it.
      returnTo: resolveReturnTo(transaction.returnTo, auth.profile.role),
      auth,
    };
  }

  /**
   * §4.12.1, with one bounded retry.
   *
   * Two passes, never more: a race resolves on the second attempt because whatever the other request
   * was creating now exists and is found by lookup. A third pass would mean something is wrong that
   * retrying cannot fix.
   */
  private async resolve(claims: IdTokenClaims, timezone: string | null): Promise<Resolution> {
    for (let pass = 0; pass < 2; pass += 1) {
      const outcome = await this.resolveOnce(claims, timezone);
      if (outcome.kind !== 'raced') return outcome;
    }

    this.logger.warn('Provider sign-in lost the same race twice; asking the user to retry.');
    return { kind: 'failed', code: 'invalid_request' };
  }

  private async resolveOnce(claims: IdTokenClaims, timezone: string | null): Promise<Resolution> {
    const now = this.clock.now();
    const identity = await this.identities.findByProviderSubject(PROVIDER, claims.sub);

    // 3a — a returning user. The email is deliberately not consulted: `sub` is the identity, so
    // someone who changed their Google address is still the same account here.
    if (identity !== null) {
      const user = await this.users.findById(identity.userId);
      // The row cascades with the account, so this is close to unreachable — and it fails closed
      // rather than opening a session for an identity pointing at nobody.
      if (user === null) return { kind: 'failed', code: 'invalid_request' };

      /*
       * A disabled account cannot sign in through a provider either, and it fails with the same
       * coarse `invalid_request` every other failure here uses. §6 rule 3 is why the codes are
       * coarse: this callback is reached by an unauthenticated caller, and a `disabled` code would
       * turn it into an oracle for the state of somebody else's account.
       *
       * Checked here rather than in `startSession`, so nothing is written first — no
       * `last_login_at`, no touched identity, and no session row to revoke afterwards.
       */
      if (user.disabledAt !== null) return { kind: 'failed', code: 'invalid_request' };

      await this.identities.touchLastLogin(identity.id, now);
      await this.users.markLogin(user.id, now);
      return { kind: 'user', user };
    }

    const existing = await this.users.findByEmail(claims.email);

    // 3b-ii — auto-link. Sound only because step 0 already refused an unverified address.
    if (existing !== null) {
      /*
       * The same refusal as the returning-user branch, and it has to be checked before the link is
       * created: auto-linking a disabled account would leave behind a credential that starts working
       * the moment the account is reactivated, without anybody having decided that.
       */
      if (existing.disabledAt !== null) return { kind: 'failed', code: 'invalid_request' };

      const linked = await this.identities.create({
        userId: existing.id,
        provider: PROVIDER,
        providerSubject: claims.sub,
        emailAtLink: claims.email,
      });
      if (!linked.ok) return { kind: 'raced' };

      // True, and newly recorded. Nothing gates on it (§11) — this is an audit fact, not a grant.
      const verified = existing.emailVerifiedAt !== null;
      if (!verified) await this.users.markEmailVerified(existing.id, now);

      await this.users.markLogin(existing.id, now);

      /*
       * The in-memory row is patched rather than re-read. `toUserProfile` derives `emailVerified`
       * from this column, so returning the record we loaded *before* the update would answer the
       * sign-in that just verified the address with `emailVerified: false` — and the client would
       * keep believing that for the life of the access token.
       */
      return { kind: 'user', user: verified ? existing : { ...existing, emailVerifiedAt: now } };
    }

    // 3b-i — a new account.
    return this.createAccount(claims, timezone, now);
  }

  /**
   * Create an account and its identity, retrying only the derived username.
   *
   * Nothing pre-checks whether a username is free, because checking and then inserting is a race:
   * two sign-ins can both find the same candidate available. The unique index refuses one of them,
   * and that refusal is the signal to derive the next candidate.
   */
  private async createAccount(
    claims: IdTokenClaims,
    timezone: string | null,
    now: Date,
  ): Promise<Resolution> {
    const names = deriveNames(claims);

    for (let attempt = 0; attempt < USERNAME_ATTEMPT_LIMIT; attempt += 1) {
      const username = normalizeUsername(deriveUsernameCandidate(claims.email, attempt));

      const created = await this.users.createFromIdentity({
        email: claims.email,
        username,
        usernameLower: usernameKey(username),
        firstName: names.firstName,
        lastName: names.lastName,
        timezone: timezone ?? DEFAULT_TIMEZONE,
        emailVerifiedAt: now,
        provider: PROVIDER,
        providerSubject: claims.sub,
      });

      if (created.ok) {
        await this.users.markLogin(created.user.id, now);
        return { kind: 'user', user: created.user };
      }

      /*
       * Only a username collision is worth another candidate. A collision on the email or on the
       * identity means the account we just failed to find now exists — so the whole algorithm is
       * re-run, and the second pass takes the sign-in branch instead.
       */
      if (created.conflicts.includes('email')) return { kind: 'raced' };
    }

    // Five collisions on a four-character random suffix is not bad luck; it is a signal.
    this.logger.warn('Exhausted username candidates while creating an account from a provider.');
    return { kind: 'failed', code: 'invalid_request' };
  }
}
