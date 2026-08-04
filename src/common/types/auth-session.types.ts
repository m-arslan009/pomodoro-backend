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

/** What the request tells us about the device, for the forensic columns. Both optional. */
export interface DeviceContext {
  readonly userAgent: string | null;
  readonly ip: string | null;
}
