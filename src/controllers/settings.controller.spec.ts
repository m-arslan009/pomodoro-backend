import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserSettings } from '../common/types/settings.types';
import type { AuthContext, UserProfile } from '../common/types/user.types';
import type { UpdateSettingsDto } from '../dto/settings.dto';
import type { SettingsService } from '../services/settings.service';
import { SettingsController } from './settings.controller';

/*
 * The `/me/settings` routes.
 *
 * The controller is instantiated directly rather than through a testing module: what is being
 * asserted is the code in these methods — which id reaches the service and what envelope comes
 * back — not that Nest can wire a constructor.
 *
 * The ownership property is the one worth stating plainly. Both methods read their subject from
 * `auth`, which the guard built from a verified token, and neither accepts an id from the caller.
 * So the tests below hand the controller an auth context for one account and a payload naming
 * another, and assert that the payload changes nothing (ADR-010).
 */

const PROFILE: UserProfile = {
  id: 'user-1',
  email: 'ada@evergrove.app',
  username: 'Ada_L',
  firstName: 'Ada',
  lastName: 'Lovelace',
  timezone: 'Europe/London',
  emailVerified: false,
  avatarUpdatedAt: null,
  createdAt: '2026-07-28T09:00:00.000Z',
};

const SETTINGS: UserSettings = {
  workMinutes: 30,
  breakMinutes: 10,
  theme: 'dark',
  customTheme: null,
  background: 'dusk',
  labels: { work: 'Deep work', break: 'Tea' },
  updatedAt: '2026-07-30T09:12:44.301Z',
};

function authFor(profile: UserProfile = PROFILE): AuthContext {
  return { userId: profile.id, profile };
}

describe('SettingsController', () => {
  let settings: SettingsService;
  let controller: SettingsController;

  beforeEach(() => {
    settings = {
      getSettings: vi.fn(() => Promise.resolve(SETTINGS)),
      updateSettings: vi.fn(() => Promise.resolve(SETTINGS)),
    } as unknown as SettingsService;

    controller = new SettingsController(settings);
  });

  describe('GET /me/settings', () => {
    it('reads the preferences of the account the token names', async () => {
      // The route takes no id. The only subject available to it is the token's.
      await controller.read(authFor());

      expect(settings.getSettings).toHaveBeenCalledWith('user-1');
      expect(settings.getSettings).toHaveBeenCalledTimes(1);
    });

    it('answers in a settings envelope, never a user one', async () => {
      // Parallel to profile's `{ user: … }` but deliberately separate: the two payloads are never
      // merged and never returned by the same endpoint (CONTRACT.md §2.2).
      await expect(controller.read(authFor())).resolves.toEqual({ settings: SETTINGS });
    });

    it('does not fall back to the profile the guard already loaded', async () => {
      // Preferences are not on the profile and must not be inferred from it — putting them there
      // would add a join to every authenticated request in the application.
      const result = await controller.read(authFor());

      expect(result).not.toHaveProperty('user');
      expect(result.settings).not.toHaveProperty('email');
    });
  });

  describe('PATCH /me/settings', () => {
    it('updates the account the token names', async () => {
      await controller.update(authFor(), { workMinutes: 30 });

      expect(settings.updateSettings).toHaveBeenCalledWith('user-1', { workMinutes: 30 });
    });

    it('passes the validated body through untouched', async () => {
      // The pipe has already parsed and trimmed it; the controller adds no interpretation of its
      // own, so a rule can only live in one place.
      const dto: UpdateSettingsDto = {
        theme: 'dark',
        customTheme: null,
        labels: { work: 'Deep work', break: 'Tea' },
      };

      await controller.update(authFor(), dto);

      expect(settings.updateSettings).toHaveBeenCalledWith('user-1', dto);
    });

    it('ignores an id in the body, because it never reads one', async () => {
      /*
       * There is no path parameter and no id field in the DTO. This pins the behaviour at the
       * controller: the payload names another account and the write still goes to the token's
       * subject.
       *
       * The schema rejects such a body outright before it ever arrives here (see
       * settings.dto.spec.ts); the cast bypasses that to test this layer on its own.
       */
      const body = { workMinutes: 30, userId: 'someone-elses-id' } as unknown as UpdateSettingsDto;

      await controller.update(authFor(), body);

      expect(settings.updateSettings).toHaveBeenCalledWith('user-1', expect.anything());
    });

    it('writes for the token subject even when a different profile is in scope', async () => {
      const other: UserProfile = { ...PROFILE, id: 'user-2', username: 'Grace_H' };

      await controller.update(authFor(other), { workMinutes: 30 });

      expect(settings.updateSettings).toHaveBeenCalledWith('user-2', expect.anything());
    });

    it('returns the updated settings in the same envelope as the read', async () => {
      // The client replaces its state from this response rather than from what it submitted, so
      // both routes have to answer in the same shape.
      await expect(controller.update(authFor(), { workMinutes: 30 })).resolves.toEqual({
        settings: SETTINGS,
      });
    });

    it('does not read the settings back after writing them', async () => {
      // The upsert already returns the whole row; a second read would be a wasted round trip and
      // a window in which another save could change the answer.
      await controller.update(authFor(), { workMinutes: 30 });

      expect(settings.getSettings).not.toHaveBeenCalled();
    });
  });
});
