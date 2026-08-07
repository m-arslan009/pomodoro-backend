/*
 * The shapes that cross the repository boundary for `auth_sessions`. Plain data: the ORM's row type
 * stops at `AuthSessionRepository` (ADR-020), so nothing above it depends on Prisma's generated
 * client.
 */

/** A session row as the repository hands it out. Never carries the token — only its digest existed. */
export interface AuthSessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly revokedAt: Date | null;
}

/**
 * A freshly minted refresh token, on its way to a `Set-Cookie` header.
 *
 * `token` is the **plaintext**, and this is the only shape in the codebase that carries it. It is
 * produced, written to the response, and dropped — it is never logged, never persisted, and never
 * returned from a read. Everything stored is `sha256(token)`.
 */
export interface IssuedRefreshToken {
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * What the request tells us about the device, for the forensic columns. All optional.
 *
 * `requestId` is NOT a session column and is never written to `auth_sessions`. It rides along here
 * because reuse detection happens deep inside `rotate()`, on this exact path, and the audit row it
 * writes needs the id that joins it to its Pino log line and to the Problem Details `instance` of
 * the same request (ADR-016). Carrying it on the context the path already threads is what the
 * alternative — a second parameter plumbed through `AuthService.refresh` purely for one audit row —
 * would have duplicated.
 *
 * It is optional rather than required so the call sites that have no request to read it from (the
 * OAuth completion path, tests) construct this shape unchanged.
 */
export interface DeviceContext {
  readonly userAgent: string | null;
  readonly ip: string | null;
  readonly requestId?: string | null;
}
