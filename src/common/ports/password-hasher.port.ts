/*
 * One of the two ports this architecture allows (ADR-005). It exists because the hashing
 * algorithm is expected to change — Argon2id today, bcrypt if the native binding ever causes
 * build friction, something else in five years — and because tests must not spend 100ms of
 * deliberate CPU per fixture.
 *
 * Declared as an abstract class rather than an interface so it doubles as the DI token.
 */
export abstract class PasswordHasher {
  abstract hash(plain: string): Promise<string>;

  /** Never throws: a malformed stored hash is a failed verification, not a 500. */
  abstract verify(hashed: string, plain: string): Promise<boolean>;

  /**
   * Runs the same work as `verify` against a throwaway hash.
   *
   * Called when no user matched, so that a login attempt for an unknown account costs the same
   * time as one for a known account. Without it, a fast 401 enumerates registered users even
   * though the response body is identical.
   */
  abstract verifyDummy(plain: string): Promise<void>;

  /** True when the stored hash was produced with weaker parameters than current policy. */
  abstract needsRehash(hashed: string): boolean;
}
