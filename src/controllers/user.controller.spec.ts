import type { Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../common/errors/problem.exception';
import type { AuthContext, UserProfile } from '../common/types/user.types';
import type { AvatarService, UploadedImage } from '../services/avatar.service';
import type { UserService } from '../services/user.service';
import { UserController } from './user.controller';

/*
 * The `/me` routes.
 *
 * The controller is instantiated directly rather than through a testing module: what is being
 * asserted is the code in these methods — which id reaches the services, and the conditional
 * response behaviour on the avatar read — not that Nest can wire a constructor.
 *
 * The ownership property is the one worth stating plainly. Every method reads its subject from
 * `auth`, which the guard built from a verified token, and none of them accepts an id from the
 * caller. So the tests below hand the controller an auth context for one account and a payload
 * naming another, and assert that the payload changes nothing (ADR-010).
 */

const NOW = '2026-07-29T18:44:16.315Z';

const PROFILE: UserProfile = {
  id: 'user-1',
  email: 'ada@evergrove.app',
  username: 'Ada_L',
  firstName: 'Ada',
  lastName: 'Lovelace',
  timezone: 'Europe/London',
  role: 'user',
  emailVerified: false,
  avatarUpdatedAt: null,
  createdAt: '2026-07-28T09:00:00.000Z',
};

function authFor(profile: UserProfile = PROFILE): AuthContext {
  return { userId: profile.id, profile };
}

/** Only the members the controller actually calls on an express response. */
interface FakeResponse {
  setHeader(name: string, value: string): void;
  status(code: number): FakeResponse;
  end(): FakeResponse;
  type(value: string): FakeResponse;
  send(body: Buffer): FakeResponse;
}

function makeResponse() {
  const headers: Record<string, string> = {};
  const sent = {
    status: 200,
    contentType: '',
    body: undefined as Buffer | undefined,
    ended: false,
  };

  // Annotated rather than inferred: these methods return the object they are defined on, which
  // TypeScript cannot infer without circularity.
  const response: FakeResponse = {
    setHeader: (name, value) => {
      headers[name] = value;
    },
    status: (code) => {
      sent.status = code;
      return response;
    },
    end: () => {
      sent.ended = true;
      return response;
    },
    type: (value) => {
      sent.contentType = value;
      return response;
    },
    send: (body) => {
      sent.body = body;
      return response;
    },
  };

  return { response: response as unknown as Response, headers, sent };
}

const IMAGE = {
  data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  contentType: 'image/png',
  byteSize: 4,
  width: 256,
  height: 256,
};

describe('UserController', () => {
  let users: UserService;
  let avatars: AvatarService;
  let controller: UserController;

  beforeEach(() => {
    users = {
      updateProfile: vi.fn(() => Promise.resolve(PROFILE)),
    } as unknown as UserService;

    avatars = {
      replace: vi.fn(() => Promise.resolve(PROFILE)),
      read: vi.fn(() => Promise.resolve(IMAGE)),
    } as unknown as AvatarService;

    controller = new UserController(users, avatars);
  });

  describe('GET /me', () => {
    it('answers with the profile the guard loaded', () => {
      // The guard re-reads the row on every authenticated request, so this is already fresh — the
      // endpoint exists to be polled for exactly that reason.
      expect(controller.read(authFor())).toEqual({ user: PROFILE });
    });
  });

  describe('PATCH /me', () => {
    it('updates the account the token names', async () => {
      await controller.update(authFor(), { firstName: 'Grace' });

      expect(users.updateProfile).toHaveBeenCalledWith('user-1', { firstName: 'Grace' });
    });

    it('ignores an id in the body, because it never reads one', async () => {
      // There is no path parameter and no id field in the DTO. This pins that: the payload names
      // another account and the write still goes to the token's subject.
      const body = { firstName: 'Grace', id: 'someone-elses-id' };

      await controller.update(authFor(), body);

      expect(users.updateProfile).toHaveBeenCalledWith('user-1', expect.anything());
    });

    it('returns the updated profile in the same envelope as the read', async () => {
      await expect(controller.update(authFor(), { firstName: 'Grace' })).resolves.toEqual({
        user: PROFILE,
      });
    });
  });

  describe('PUT /me/avatar', () => {
    const file: UploadedImage = { buffer: Buffer.from([1, 2, 3]), size: 3 };

    it('replaces the photo of the account the token names', async () => {
      await controller.replaceAvatar(authFor(), file);

      expect(avatars.replace).toHaveBeenCalledWith('user-1', file);
    });

    it('hands a missing file to the service to refuse', async () => {
      // The field-error message belongs with the other upload rejections, not split across layers.
      await controller.replaceAvatar(authFor(), undefined);

      expect(avatars.replace).toHaveBeenCalledWith('user-1', undefined);
    });

    it('returns the profile so the client can re-render without a second request', async () => {
      await expect(controller.replaceAvatar(authFor(), file)).resolves.toEqual({ user: PROFILE });
    });
  });

  describe('GET /me/avatar', () => {
    const withAvatar = authFor({ ...PROFILE, avatarUpdatedAt: NOW });

    it('serves the bytes with the type the sniffer settled on', async () => {
      const { response, headers, sent } = makeResponse();

      await controller.readAvatar(withAvatar, undefined, response);

      expect(sent.contentType).toBe('image/png');
      expect(sent.body).toEqual(Buffer.from(IMAGE.data));
      expect(avatars.read).toHaveBeenCalledWith('user-1');
      // Never the value the uploader supplied, and inline so a browser renders rather than
      // downloads it.
      expect(headers['Content-Disposition']).toBe('inline');
    });

    it('caches privately and revalidates every time', async () => {
      const { response, headers } = makeResponse();

      await controller.readAvatar(withAvatar, undefined, response);

      // Private because the image is served only to its owner; must-revalidate because the ETag
      // is what makes an unchanged photo cheap, not a freshness window.
      expect(headers['Cache-Control']).toBe('private, max-age=0, must-revalidate');
      expect(headers.ETag).toBe(`"${NOW}"`);
    });

    it('answers a matching ETag with 304, without touching the image table', async () => {
      const { response, sent } = makeResponse();

      await controller.readAvatar(withAvatar, `"${NOW}"`, response);

      expect(sent.status).toBe(304);
      expect(sent.ended).toBe(true);
      expect(sent.body).toBeUndefined();
      // The marker rides on the user row the guard already read, so an unchanged photo costs no
      // query at all.
      expect(avatars.read).not.toHaveBeenCalled();
    });

    it('serves the bytes again when the ETag is stale', async () => {
      const { response, sent } = makeResponse();

      await controller.readAvatar(withAvatar, '"2026-01-01T00:00:00.000Z"', response);

      expect(sent.status).toBe(200);
      expect(sent.body).toEqual(Buffer.from(IMAGE.data));
    });

    it('reports an account with no photo as not found, without a lookup', async () => {
      const { response } = makeResponse();

      const error = (await controller
        .readAvatar(authFor(), undefined, response)
        .catch((caught: unknown) => caught)) as ProblemException;

      expect(error).toBeInstanceOf(ProblemException);
      expect(error.problem.status).toBe(404);
      expect(error.problem.detail).toBe('This account has no profile photo.');
      // avatarUpdatedAt is null, so there is nothing to find and no reason to look.
      expect(avatars.read).not.toHaveBeenCalled();
    });

    it('reads the photo of the account the token names, not one the caller asks for', async () => {
      const { response } = makeResponse();

      await controller.readAvatar(withAvatar, undefined, response);

      // The route takes no id. The only subject available to it is the token's.
      expect(avatars.read).toHaveBeenCalledWith('user-1');
      expect(avatars.read).toHaveBeenCalledTimes(1);
    });
  });
});
