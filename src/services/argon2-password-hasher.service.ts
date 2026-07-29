import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { PasswordHasher } from '../common/ports/password-hasher.port';

/*
 * Argon2id at OWASP's recommended parameters (m=19 MiB, t=2, p=1).
 *
 * The encoded hash carries its own salt, version and parameters, which is why the users table
 * needs no salt/algorithm/iterations columns and why needsRehash can be answered from the
 * stored string alone.
 *
 * `algorithm` is left at the library default, which is Argon2id: the exported `Algorithm` enum
 * is an ambient const enum and cannot be referenced under `isolatedModules`. needsRehash below
 * asserts the `$argon2id$` prefix, so if that default ever changed, every hash would be
 * scheduled for upgrade rather than silently accepted.
 */
const OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Matches `$argon2id$v=19$m=19456,t=2,p=1$…` so current parameters can be compared. */
const ENCODED_PARAMS = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/;

@Injectable()
export class Argon2PasswordHasher extends PasswordHasher {
  /**
   * Hash of a value nobody knows, computed once on first use.
   *
   * Its only purpose is to burn the same CPU for a login against an unknown account as for a
   * real one. Stored as the promise so concurrent first-time callers share one computation.
   */
  private dummyHash?: Promise<string>;

  async hash(plain: string): Promise<string> {
    return hash(plain, OPTIONS);
  }

  async verify(hashed: string, plain: string): Promise<boolean> {
    try {
      return await verify(hashed, plain);
    } catch {
      // A stored hash we cannot parse is a failed verification, not a server error.
      return false;
    }
  }

  async verifyDummy(plain: string): Promise<void> {
    this.dummyHash ??= hash(randomBytes(32).toString('base64url'), OPTIONS);
    await this.verify(await this.dummyHash, plain);
  }

  needsRehash(hashed: string): boolean {
    const match = ENCODED_PARAMS.exec(hashed);
    // Unrecognised format — a bcrypt fallback hash, or an older algorithm. Upgrade it.
    if (!match) return true;

    return (
      Number(match[1]) < OPTIONS.memoryCost ||
      Number(match[2]) < OPTIONS.timeCost ||
      Number(match[3]) !== OPTIONS.parallelism
    );
  }
}
