import { describe, expect, it } from 'vitest';
import {
  classifyIdentifier,
  emailLocalPart,
  isValidUsername,
  normalizeEmail,
  normalizeUsername,
  usernameKey,
} from './identifier';

describe('identifier normalisation', () => {
  it('stores emails trimmed and lowercased', () => {
    expect(normalizeEmail('  Ada@Evergrove.APP ')).toBe('ada@evergrove.app');
  });

  it('preserves username casing for display but not for uniqueness', () => {
    // The approved refinement: `@Ada_L` stays `Ada_L` on screen while colliding with `ada_l`.
    expect(normalizeUsername('  Ada_L  ')).toBe('Ada_L');
    expect(usernameKey('  Ada_L  ')).toBe('ada_l');
  });
});

describe('login identifier classification', () => {
  it('routes a value containing @ to the email column', () => {
    expect(classifyIdentifier(' Ada@Evergrove.app ')).toEqual({
      kind: 'email',
      value: 'ada@evergrove.app',
    });
  });

  it('routes a value without @ to the username key', () => {
    expect(classifyIdentifier('  ADA_L ')).toEqual({ kind: 'username', value: 'ada_l' });
  });

  it('is unambiguous because usernames cannot contain @', () => {
    // This is what makes detection deterministic rather than a guess.
    expect(isValidUsername('ada@l')).toBe(false);
  });

  it('classifies malformed input without rejecting it', () => {
    // Login must not answer "that is not a valid email" — that answer varies by cause and
    // enumerates accounts. A malformed value is simply looked up and not found.
    expect(classifyIdentifier('@@@').kind).toBe('email');
    expect(classifyIdentifier('   ').kind).toBe('username');
  });
});

describe('emailLocalPart', () => {
  it('returns the part before @, or the whole value when there is none', () => {
    expect(emailLocalPart('ada@evergrove.app')).toBe('ada');
    expect(emailLocalPart('ada')).toBe('ada');
  });
});
