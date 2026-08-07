import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../common/errors/problem.exception';
import type { UserRecord } from '../common/types/user.types';
import type { UpdateProfileInput, UserRepository } from '../repositories/user.repository';
import { UserService } from './user.service';

/*
 * Profile writes for the signed-in account.
 *
 * The repository is a fake rather than a mock with expectations: what matters is the input it is
 * handed and the outcome each of its answers produces, not the call sequence used to get there.
 *
 * Ownership is absent from these tests because it is absent from the code — every method takes the
 * id the guard read off a verified token, and no route accepts one from the caller (ADR-010).
 * There is no "can this user edit that profile?" branch to cover, which is the point.
 */

const NOW = new Date('2026-07-28T09:00:00.000Z');

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 'user-1',
    email: 'ada@evergrove.app',
    username: 'Ada_L',
    usernameLower: 'ada_l',
    firstName: 'Ada',
    lastName: 'Lovelace',
    passwordHash: 'hashed:correct horse battery staple',
    timezone: 'Europe/London',
    role: 'user',
    emailVerifiedAt: null,
    passwordChangedAt: NOW,
    lastLoginAt: null,
    avatarUpdatedAt: null,
    disabledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('UserService', () => {
  let patches: UpdateProfileInput[];
  let answer: { ok: true; user: UserRecord | null } | { ok: false };
  let users: UserRepository;
  let service: UserService;

  beforeEach(() => {
    patches = [];
    answer = { ok: true, user: makeUser() };

    users = {
      updateProfile: vi.fn((_id: string, data: UpdateProfileInput) => {
        patches.push(data);
        return Promise.resolve(answer);
      }),
    } as unknown as UserRepository;

    service = new UserService(users);
  });

  describe('updateProfile', () => {
    it('writes the update against the id it was given', async () => {
      await service.updateProfile('user-1', { firstName: 'Grace' });

      expect(users.updateProfile).toHaveBeenCalledWith('user-1', expect.anything());
    });

    it('leaves the fields the request omitted alone', async () => {
      await service.updateProfile('user-1', { firstName: 'Grace' });

      // undefined is how the repository is told "do not touch this column". Sending the current
      // value back instead would turn every PATCH into a full-row write.
      expect(patches[0]).toEqual({
        firstName: 'Grace',
        lastName: undefined,
        username: undefined,
        usernameLower: undefined,
        timezone: undefined,
      });
    });

    it('moves the username and its uniqueness key in the same write', async () => {
      await service.updateProfile('user-1', { username: 'Grace_H' });

      // They cannot travel separately: the CHECK constraint rejects a row where the key does not
      // match the handle, which is the protection it exists to provide.
      expect(patches[0]).toMatchObject({ username: 'Grace_H', usernameLower: 'grace_h' });
    });

    it('derives the uniqueness key case-insensitively', async () => {
      await service.updateProfile('user-1', { username: 'GRACE_H' });

      expect(patches[0]?.usernameLower).toBe('grace_h');
    });

    it('passes a timezone change through unchanged', async () => {
      // Already validated by the DTO against the runtime's zone table; there is nothing left for
      // the service to decide.
      await service.updateProfile('user-1', { timezone: 'Asia/Karachi' });

      expect(patches[0]?.timezone).toBe('Asia/Karachi');
    });

    it('answers with the stored row, not the submitted values', async () => {
      answer = { ok: true, user: makeUser({ firstName: 'Grace', username: 'Grace_H' }) };

      const profile = await service.updateProfile('user-1', { firstName: 'Grace' });

      expect(profile).toMatchObject({ firstName: 'Grace', username: 'Grace_H' });
    });

    it('never returns credential material', async () => {
      const profile = await service.updateProfile('user-1', { firstName: 'Grace' });

      expect(profile).not.toHaveProperty('passwordHash');
      expect(profile).not.toHaveProperty('usernameLower');
      expect(Object.values(profile)).not.toContain('hashed:correct horse battery staple');
    });

    it('reports a taken username as a field error the form can render', async () => {
      answer = { ok: false };

      const error = (await service
        .updateProfile('user-1', { username: 'Grace_H' })
        .catch((caught: unknown) => caught)) as ProblemException;

      expect(error).toBeInstanceOf(ProblemException);
      expect(error.problem.status).toBe(409);
      expect(error.problem.errors).toEqual([
        { field: 'username', message: 'That username is already taken.' },
      ]);
    });

    it('refuses when the account no longer exists', async () => {
      // The row vanished between authenticating and saving. A token that named it is no longer
      // usable, so this is 401 rather than 404 — there is nobody to be not-found.
      answer = { ok: true, user: null };

      await expect(service.updateProfile('user-1', { firstName: 'Grace' })).rejects.toMatchObject({
        problem: { status: 401, title: 'Not authenticated' },
      });
    });

    it('reports the avatar marker without inlining any bytes', async () => {
      answer = { ok: true, user: makeUser({ avatarUpdatedAt: NOW }) };

      const profile = await service.updateProfile('user-1', { firstName: 'Grace' });

      // The client uses this to decide whether to fetch the image at all, and as its cache key.
      expect(profile.avatarUpdatedAt).toBe(NOW.toISOString());
    });
  });
});
