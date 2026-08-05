import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CLOCK_LEEWAY_MS,
  createPkcePair,
  decodeJwtPayload,
  deriveNames,
  deriveUsernameCandidate,
  isOAuthProvider,
  randomUrlToken,
  resolveReturnTo,
  validateIdTokenClaims,
} from './oauth';

/*
 * The pure rules behind provider sign-in.
 *
 * These are the decisions that decide whether a stranger's assertion becomes an Evergrove account,
 * and every one of them is reachable without a server, a network or a database — which is exactly
 * why they live in src/domain. Testing `validateIdTokenClaims` through the service would be testing
 * it at a distance; here each rejection can be aimed at one claim at a time.
 */

const NOW = new Date('2026-08-05T09:00:00.000Z');
const CLIENT_ID = 'evergrove-test.apps.googleusercontent.com';
const NONCE = 'nonce-value';

const secondsAt = (offsetMs: number) => Math.floor((NOW.getTime() + offsetMs) / 1000);

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * A token in the shape one arrives in. The signature is deliberately nonsense: this codebase does
 * not verify it, because the token is only ever read after being fetched over a TLS-authenticated
 * back-channel call we initiated (OIDC Core §3.1.3.7).
 */
function tokenWith(overrides: Record<string, unknown> = {}): string {
  const payload = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: 'google-subject-1',
    email: 'Ada@Evergrove.app',
    email_verified: true,
    given_name: 'Ada',
    family_name: 'Lovelace',
    name: 'Ada Lovelace',
    nonce: NONCE,
    iat: secondsAt(-30_000),
    exp: secondsAt(3_600_000),
    ...overrides,
  };
  return `${encodeSegment({ alg: 'RS256' })}.${encodeSegment(payload)}.not-a-real-signature`;
}

const validate = (token: string, nonce = NONCE) =>
  validateIdTokenClaims(token, { audience: CLIENT_ID, nonce, now: NOW });

describe('OAuth domain rules', () => {
  describe('isOAuthProvider', () => {
    it('recognises google and nothing else', () => {
      expect(isOAuthProvider('google')).toBe(true);
      // A second provider is a decision, not a string: branch 3b-ii of §4.12.1 has to be re-judged
      // before any new name is accepted here or by the database CHECK that mirrors this list.
      expect(isOAuthProvider('github')).toBe(false);
      expect(isOAuthProvider('GOOGLE')).toBe(false);
      expect(isOAuthProvider('')).toBe(false);
    });
  });

  describe('resolveReturnTo', () => {
    it('passes an allow-listed app path through', () => {
      expect(resolveReturnTo('/history')).toBe('/history');
      expect(resolveReturnTo('/profile')).toBe('/profile');
    });

    it('defaults when nothing was asked for', () => {
      expect(resolveReturnTo(undefined)).toBe('/timer');
    });

    it('refuses anything that could leave the application', () => {
      /*
       * An open redirect on an authentication callback is a credential-theft primitive: the victim
       * clicks a genuine Evergrove link and lands on a page the attacker chose. Matching against
       * known paths cannot be fooled by an encoding the checker and the browser read differently,
       * which is how "reject anything containing `//` or `:`" eventually fails.
       */
      for (const hostile of [
        'https://evil.test/harvest',
        '//evil.test/harvest',
        '/timer/../../evil',
        'javascript:alert(1)',
        '/timer?next=https://evil.test',
        '',
      ]) {
        expect(resolveReturnTo(hostile)).toBe('/timer');
      }
    });
  });

  describe('createPkcePair', () => {
    it('derives the challenge as the SHA-256 of the verifier', () => {
      const pair = createPkcePair();

      expect(pair.challenge).toBe(createHash('sha256').update(pair.verifier).digest('base64url'));
    });

    it('produces a fresh verifier every time, in a URL-safe alphabet', () => {
      const first = createPkcePair();
      const second = createPkcePair();

      expect(first.verifier).not.toBe(second.verifier);
      // base64url only — a `+`, `/` or `=` would be re-encoded in transit and stop matching.
      expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(first.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
  });

  describe('randomUrlToken', () => {
    it('is unguessable and safe to put in a query string', () => {
      const tokens = new Set(Array.from({ length: 50 }, () => randomUrlToken()));

      expect(tokens.size).toBe(50);
      for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
  });

  describe('deriveNames', () => {
    const base = { givenName: null, familyName: null, name: null, email: 'ada@evergrove.app' };

    it('prefers the structured claims', () => {
      expect(deriveNames({ ...base, givenName: 'Ada', familyName: 'Lovelace' })).toEqual({
        firstName: 'Ada',
        lastName: 'Lovelace',
      });
    });

    it('splits the display name when the structured claims are absent', () => {
      expect(deriveNames({ ...base, name: 'Ada Lovelace' })).toEqual({
        firstName: 'Ada',
        lastName: 'Lovelace',
      });
    });

    it('keeps everything after the first space as the last name', () => {
      expect(deriveNames({ ...base, name: 'Ada King Lovelace' })).toEqual({
        firstName: 'Ada',
        lastName: 'King Lovelace',
      });
    });

    it('accepts a mononym rather than refusing the sign-in', () => {
      // OIDC makes both name claims optional and much of the world uses one name. A derivation that
      // insisted on two would fail account creation for those users.
      expect(deriveNames({ ...base, name: 'Prince' })).toEqual({
        firstName: 'Prince',
        lastName: 'User',
      });
    });

    it('removes digits, which the registration rules forbid in a name', () => {
      // Replaced with a space rather than deleted: "John2Smith" is two words with a typo between
      // them, not "JohnSmith".
      expect(deriveNames({ ...base, givenName: 'John2Smith', familyName: 'Doe9' })).toEqual({
        firstName: 'John Smith',
        lastName: 'Doe',
      });
    });

    it('falls back to the email local part, then to a placeholder', () => {
      expect(deriveNames({ ...base, email: 'ada@evergrove.app' })).toEqual({
        firstName: 'ada',
        lastName: 'User',
      });
      // Nothing usable anywhere: still an account, with names the user can edit.
      expect(deriveNames({ ...base, email: '1@evergrove.app' })).toEqual({
        firstName: 'Evergrove',
        lastName: 'User',
      });
    });

    it('clamps an over-long name to what the column accepts', () => {
      const derived = deriveNames({ ...base, givenName: 'A'.repeat(120) });

      expect(derived.firstName).toHaveLength(50);
    });
  });

  describe('deriveUsernameCandidate', () => {
    it('uses the email local part on the first attempt', () => {
      expect(deriveUsernameCandidate('ada_l@evergrove.app', 0)).toBe('ada_l');
    });

    it('strips characters the username rule does not allow', () => {
      expect(deriveUsernameCandidate('ada.lovelace+work@evergrove.app', 0)).toBe('adalovelacework');
    });

    it('suffixes a fresh candidate on every attempt after the first', () => {
      const second = deriveUsernameCandidate('ada@evergrove.app', 1);
      const third = deriveUsernameCandidate('ada@evergrove.app', 2);

      expect(second).toMatch(/^ada_[a-z0-9]{4}$/);
      expect(third).toMatch(/^ada_[a-z0-9]{4}$/);
      expect(second).not.toBe(third);
    });

    it('suffixes immediately when the local part is too short to stand alone', () => {
      // Below the three-character minimum, so attempt zero cannot use it as-is.
      expect(deriveUsernameCandidate('ab@evergrove.app', 0)).toMatch(/^ab_[a-z0-9]{4}$/);
    });

    it('never exceeds the column length, however long the address', () => {
      for (const attempt of [0, 1, 4]) {
        const candidate = deriveUsernameCandidate(`${'a'.repeat(80)}@evergrove.app`, attempt);
        expect(candidate.length).toBeLessThanOrEqual(20);
        expect(candidate.length).toBeGreaterThanOrEqual(3);
        expect(candidate).toMatch(/^[a-z0-9_]+$/);
      }
    });

    it('still produces something when the local part sanitises away entirely', () => {
      expect(deriveUsernameCandidate('...@evergrove.app', 0)).toBe('user');
    });
  });

  describe('decodeJwtPayload', () => {
    it('reads a well-formed payload', () => {
      expect(decodeJwtPayload(tokenWith({ sub: 'abc' }))?.sub).toBe('abc');
    });

    it('refuses anything that is not three segments of JSON', () => {
      expect(decodeJwtPayload('not-a-token')).toBeNull();
      expect(decodeJwtPayload('a.b')).toBeNull();
      expect(decodeJwtPayload('a.!!!not-base64!!!.c')).toBeNull();
      // A JSON array parses but is not a claim set.
      expect(decodeJwtPayload(`${encodeSegment({})}.${encodeSegment([1, 2])}.sig`)).toBeNull();
    });
  });

  describe('validateIdTokenClaims', () => {
    it('accepts a well-formed token and normalises the address', () => {
      const claims = validate(tokenWith());

      expect(claims).toEqual({
        sub: 'google-subject-1',
        // Lowercased here so the lookup in branch 3b-ii matches the stored, lowercase column.
        email: 'ada@evergrove.app',
        emailVerified: true,
        givenName: 'Ada',
        familyName: 'Lovelace',
        name: 'Ada Lovelace',
      });
    });

    it('accepts both spellings of the Google issuer', () => {
      expect(validate(tokenWith({ iss: 'accounts.google.com' }))).not.toBeNull();
      expect(validate(tokenWith({ iss: 'https://accounts.google.com' }))).not.toBeNull();
    });

    it('refuses a token from any other issuer', () => {
      expect(validate(tokenWith({ iss: 'https://accounts.evil.test' }))).toBeNull();
      expect(validate(tokenWith({ iss: undefined }))).toBeNull();
    });

    it('refuses a token minted for a different client', () => {
      // Without this, an ID token issued to any other Google application would be accepted here —
      // the classic confused-deputy sign-in.
      expect(validate(tokenWith({ aud: 'someone-elses.apps.googleusercontent.com' }))).toBeNull();
      expect(validate(tokenWith({ aud: undefined }))).toBeNull();
    });

    it('refuses a token that does not answer this authorization request', () => {
      // The nonce is what stops an ID token captured elsewhere being replayed into our callback.
      expect(validate(tokenWith(), 'a-different-nonce')).toBeNull();
      expect(validate(tokenWith({ nonce: undefined }))).toBeNull();
    });

    it('refuses an expired token but allows for clock skew', () => {
      expect(validate(tokenWith({ exp: secondsAt(-CLOCK_LEEWAY_MS * 2) }))).toBeNull();
      // Just expired, inside the tolerance: two clocks are never exactly the same clock.
      expect(validate(tokenWith({ exp: secondsAt(-CLOCK_LEEWAY_MS / 2) }))).not.toBeNull();
    });

    it('refuses a token issued implausibly far in the future', () => {
      expect(validate(tokenWith({ iat: secondsAt(CLOCK_LEEWAY_MS * 2) }))).toBeNull();
      expect(validate(tokenWith({ iat: secondsAt(CLOCK_LEEWAY_MS / 2) }))).not.toBeNull();
    });

    it('refuses a token with no usable subject or address', () => {
      expect(validate(tokenWith({ sub: undefined }))).toBeNull();
      expect(validate(tokenWith({ sub: '   ' }))).toBeNull();
      expect(validate(tokenWith({ email: undefined }))).toBeNull();
      expect(validate(tokenWith({ email: 'not-an-address' }))).toBeNull();
      expect(validate(tokenWith({ email: `${'a'.repeat(330)}@evergrove.app` }))).toBeNull();
    });

    it('treats an absent verification claim as unverified', () => {
      /*
       * Absent is not verified. A token without the claim is one we do not understand, and
       * defaulting an unknown to `true` is precisely how auto-linking in branch 3b-ii turns into an
       * account takeover.
       */
      expect(validate(tokenWith({ email_verified: undefined }))?.emailVerified).toBe(false);
      expect(validate(tokenWith({ email_verified: 'true' }))?.emailVerified).toBe(false);
      expect(validate(tokenWith({ email_verified: false }))?.emailVerified).toBe(false);
    });

    it('reports a claim set rather than throwing on a malformed token', () => {
      expect(validate('garbage')).toBeNull();
    });

    it('leaves optional name claims null rather than inventing them', () => {
      const claims = validate(
        tokenWith({ given_name: undefined, family_name: undefined, name: undefined }),
      );

      expect(claims).toMatchObject({ givenName: null, familyName: null, name: null });
    });
  });
});
