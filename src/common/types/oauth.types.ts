import type { OAuthProvider } from '../../domain/oauth';

/*
 * Plain shapes for the provider sign-in flow (ADR-008a).
 *
 * Nothing here ever reaches a client. The whole point of the backend-driven design is that the
 * browser sees a redirect and a `Set-Cookie` and never an authorization code, a verifier, an ID
 * token or a provider token — so these types describe values that live entirely on this side.
 */

/** A row of `auth_identities`, mapped off Prisma so the ORM stops at the repository. */
export interface AuthIdentityRecord {
  readonly id: string;
  readonly userId: string;
  readonly provider: OAuthProvider;
  readonly providerSubject: string;
  readonly emailAtLink: string | null;
  readonly linkedAt: Date;
  readonly lastLoginAt: Date | null;
}

/**
 * Re-exported rather than declared here. The shape and the rules that produce it are the same
 * decision, and `src/domain` imports nothing — so the validator cannot reach up to a type in this
 * file, and a second declaration would be free to drift away from the one that is enforced.
 */
export type { IdTokenClaims } from '../../domain/oauth';

/**
 * What the `evergrove_oauth` cookie carries between the two halves of the flow.
 *
 * It is a signed JWT rather than a database row on purpose (ADR-014, and ADR-008a): a table would
 * need a row per *attempted* sign-in and a sweep to clear the abandoned ones. Signing also makes the
 * cookie unforgeable, which is what turns comparing `state` against it into a real double-submit
 * CSRF defence rather than a ritual.
 */
export interface OAuthTransaction {
  /** Echoed by the provider and compared on return. Binds the callback to *this* request. */
  readonly state: string;
  /** Bound into the ID token by the provider. Stops an ID token captured elsewhere being replayed. */
  readonly nonce: string;
  /** The PKCE secret. Never leaves this side; only its SHA-256 was sent to the provider. */
  readonly codeVerifier: string;
  /** An already-allow-listed app path. Validated on the way in, so it is safe on the way out. */
  readonly returnTo: string;
  /** The browser's IANA zone, forwarded so an account created here buckets its days correctly. */
  readonly timezone: string | null;
}

/**
 * The outcome of resolving a validated set of claims to an account.
 *
 * A failure names a §4.12 code rather than carrying a message: the client owns every word a user
 * reads, and the provider's own `error_description` is never forwarded anywhere near it.
 */
export type ResolutionOutcome =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly code: OAuthErrorCode };

/** The complete set of codes that may appear in `?oauth_error=` (CONTRACT.md §4.12). */
export const OAUTH_ERROR_CODES = [
  'access_denied',
  'invalid_request',
  'email_unverified',
  'email_exists',
  'already_linked',
  'provider_unavailable',
] as const;

export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number];
