import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GamificationSnapshot } from '../common/types/session.types';
import type { AuthContext, UserProfile } from '../common/types/user.types';
import type { GamificationService } from '../services/gamification.service';
import { GamificationController } from './gamification.controller';

/*
 * The `/gamification` route (CONTRACT.md §16.7).
 *
 * Read-only, and the only route that exposes the projection on its own. Every write path runs
 * through recording a session, because points exist only as a consequence of work: an endpoint that
 * could set them would be an endpoint that could grant titles.
 *
 * `POST /sessions` already returns this object, so the client needs this route only at sign-in, to
 * seed state before any session has been recorded in that browser. The surface is therefore
 * deliberately tiny, and most of what is worth asserting is what is ABSENT from it.
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

const GAMIFICATION: GamificationSnapshot = {
  balance: 550,
  lifetimePoints: 1050,
  currentDayStreak: 3,
  longestDayStreak: 7,
  currentSessionRun: 2,
  streakFreezesAvailable: 1,
  pointsDelta: 0,
  unlockedTitles: ['anchor'],
  newlyUnlocked: [],
};

function authFor(profile: UserProfile = PROFILE): AuthContext {
  return { userId: profile.id, profile };
}

describe('GamificationController', () => {
  let gamification: GamificationService;
  let controller: GamificationController;

  beforeEach(() => {
    gamification = {
      getGamification: vi.fn(() => Promise.resolve(GAMIFICATION)),
    } as unknown as GamificationService;

    controller = new GamificationController(gamification);
  });

  it('reads the account the token names', async () => {
    await controller.read(authFor());

    expect(gamification.getGamification).toHaveBeenCalledWith('user-1');
  });

  it('accepts no parameters at all', () => {
    /*
     * The signature is the guarantee. With nothing but `auth` to read, there is no id to
     * substitute and no filter to abuse — the route can only ever describe the caller.
     */
    expect(controller.read.length).toBe(1);
  });

  it('routes a different token to a different account', async () => {
    await controller.read(authFor({ ...PROFILE, id: 'user-2' }));

    expect(gamification.getGamification).toHaveBeenCalledWith('user-2');
  });

  it('wraps the snapshot in its envelope', async () => {
    await expect(controller.read(authFor())).resolves.toEqual({ gamification: GAMIFICATION });
  });

  it('reports a zero delta, because reading awards nothing', async () => {
    // The client announces points off `pointsDelta` and celebrates off `newlyUnlocked`. A non-zero
    // value here would congratulate someone for opening the app.
    const result = await controller.read(authFor());

    expect(result.gamification.pointsDelta).toBe(0);
    expect(result.gamification.newlyUnlocked).toEqual([]);
  });

  it('exposes no way to write', () => {
    // If a mutation ever appears on this controller, this fails — which is the point. Points are
    // earned by working, and there is deliberately no other door.
    const methods = Object.getOwnPropertyNames(GamificationController.prototype).filter(
      (name) => name !== 'constructor',
    );

    expect(methods).toEqual(['read']);
  });
});
