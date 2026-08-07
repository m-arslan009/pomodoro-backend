import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../common/errors/problem.exception';
import type { Clock } from '../common/ports/clock.port';
import type { UserRecord } from '../common/types/user.types';
import { AVATAR_MAX_BYTES } from '../domain/image';
import type {
  AvatarRecord,
  ReplaceAvatarInput,
  UserAvatarRepository,
} from '../repositories/user-avatar.repository';
import type { UserRepository } from '../repositories/user.repository';
import { AvatarService, type UploadedImage } from './avatar.service';

/*
 * The profile photo.
 *
 * The service's job is to decide what may be stored and to say why when it may not, so what is
 * asserted here is the refusal messages as much as the happy path — each one is rendered verbatim
 * beside the upload control.
 *
 * Note what has no test: an ownership check. There is none to cover. Every method takes the id the
 * guard read off a verified token, and no route accepts one from the caller (ADR-010), so there is
 * no path by which a caller could address another account's image.
 */

const NOW = new Date('2026-07-29T18:44:16.315Z');

function ascii(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0));
}

/** A PNG header of the given dimensions, padded to `total` bytes. */
function png(width: number, height: number, total = 24): Buffer {
  const bytes = Buffer.alloc(total);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set(ascii('IHDR'), 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

/** A baseline JPEG header, so "the bytes decide the type" has something to decide between. */
function jpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x08,
    0x08,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    0x03,
  ]);
}

function upload(buffer: Buffer): UploadedImage {
  return { buffer, size: buffer.byteLength };
}

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
    avatarUpdatedAt: NOW,
    disabledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('AvatarService', () => {
  let writes: Array<{ userId: string; input: ReplaceAvatarInput; at: Date }>;
  let accountExists: boolean;
  let storedAvatar: AvatarRecord | null;
  let storedUser: UserRecord | null;
  let avatars: UserAvatarRepository;
  let users: UserRepository;
  let service: AvatarService;

  beforeEach(() => {
    writes = [];
    accountExists = true;
    storedAvatar = null;
    storedUser = makeUser();

    avatars = {
      replace: vi.fn((userId: string, input: ReplaceAvatarInput, at: Date) => {
        writes.push({ userId, input, at });
        return Promise.resolve(accountExists);
      }),
      findByUserId: vi.fn(() => Promise.resolve(storedAvatar)),
    } as unknown as UserAvatarRepository;

    users = {
      findById: vi.fn(() => Promise.resolve(storedUser)),
    } as unknown as UserRepository;

    const clock: Clock = { now: () => NOW };

    service = new AvatarService(avatars, users, clock);
  });

  describe('replace', () => {
    it('stores the image against the id it was given', async () => {
      await service.replace('user-1', upload(png(256, 256)));

      expect(writes[0]?.userId).toBe('user-1');
    });

    it('records what the bytes say the image is', async () => {
      await service.replace('user-1', upload(png(256, 128, 512)));

      expect(writes[0]?.input).toMatchObject({
        contentType: 'image/png',
        width: 256,
        height: 128,
        byteSize: 512,
      });
    });

    it('takes the content type from the bytes, having no other source for it', async () => {
      // The uploader's Content-Type and filename never reach this service — UploadedImage carries
      // neither — so a text file renamed .png cannot be stored as an image by saying it is one.
      await service.replace('user-1', upload(jpeg(64, 64)));

      expect(writes[0]?.input.contentType).toBe('image/jpeg');
    });

    it('stores the bytes it was handed, unaltered', async () => {
      const bytes = png(32, 32, 64);

      await service.replace('user-1', upload(bytes));

      expect(Buffer.from(writes[0]?.input.data ?? new Uint8Array())).toEqual(bytes);
    });

    it('stamps the write with the injected clock', async () => {
      await service.replace('user-1', upload(png(16, 16)));

      // The same instant becomes the profile's avatarUpdatedAt, which is the client's cache key.
      expect(writes[0]?.at).toBe(NOW);
    });

    it('answers with the refreshed profile', async () => {
      storedUser = makeUser({ avatarUpdatedAt: NOW });

      const profile = await service.replace('user-1', upload(png(16, 16)));

      // Returned rather than a bare 204: the client needs the bumped marker to re-render without
      // a second round trip.
      expect(profile.avatarUpdatedAt).toBe(NOW.toISOString());
      expect(profile).not.toHaveProperty('passwordHash');
    });

    it('refuses a request that carried no file', async () => {
      const error = (await service
        .replace('user-1', undefined)
        .catch((caught: unknown) => caught)) as ProblemException;

      expect(error).toBeInstanceOf(ProblemException);
      expect(error.problem.status).toBe(422);
      expect(error.problem.errors).toEqual([
        { field: 'avatar', message: 'Choose an image to upload.' },
      ]);
      expect(avatars.replace).not.toHaveBeenCalled();
    });

    /*
     * Every rejection names the `avatar` field and carries a message written to be shown as-is.
     * A 422 with no field would leave the form with nowhere to put it.
     */
    const rejections: ReadonlyArray<[string, Buffer, string]> = [
      ['an empty file', Buffer.alloc(0), 'That file is empty.'],
      [
        'a file past the byte cap',
        png(16, 16, AVATAR_MAX_BYTES + 1),
        'That image is larger than 256 KB.',
      ],
      [
        'a format that is not an image at all',
        Buffer.from(ascii('this is plainly not an image')),
        'Use a PNG, JPEG, or WebP image.',
      ],
      ['a GIF', Buffer.from(ascii('GIF89a')), 'Use a PNG, JPEG, or WebP image.'],
      ['a truncated header', png(16, 16).subarray(0, 12), 'That image could not be read.'],
      [
        'an image past the dimension cap',
        png(2000, 1200),
        'That image is larger than 1024×1024 pixels.',
      ],
    ];

    it.each(rejections)('refuses %s', async (_case, buffer, message) => {
      const error = (await service
        .replace('user-1', upload(buffer))
        .catch((caught: unknown) => caught)) as ProblemException;

      expect(error.problem.status).toBe(422);
      expect(error.problem.errors).toEqual([{ field: 'avatar', message }]);
      // Nothing reaches the database until the bytes have been vouched for.
      expect(avatars.replace).not.toHaveBeenCalled();
    });

    it('refuses when the account vanished before the write landed', async () => {
      accountExists = false;

      await expect(service.replace('user-1', upload(png(16, 16)))).rejects.toMatchObject({
        problem: { status: 401, title: 'Not authenticated' },
      });
    });

    it('refuses when the account vanished after the write landed', async () => {
      storedUser = null;

      await expect(service.replace('user-1', upload(png(16, 16)))).rejects.toMatchObject({
        problem: { status: 401 },
      });
    });
  });

  describe('read', () => {
    it('returns the stored image for the id it was given', async () => {
      storedAvatar = {
        data: new Uint8Array([1, 2, 3]),
        contentType: 'image/png',
        byteSize: 3,
        width: 256,
        height: 256,
      };

      await expect(service.read('user-1')).resolves.toBe(storedAvatar);
      expect(avatars.findByUserId).toHaveBeenCalledWith('user-1');
    });

    it('reports an account with no photo as not found', async () => {
      // Having no avatar is a normal state, not a failure — the client falls back to initials on
      // this answer, so it has to be a problem document rather than an empty 200.
      const error = (await service
        .read('user-1')
        .catch((caught: unknown) => caught)) as ProblemException;

      expect(error.problem.status).toBe(404);
      expect(error.problem.detail).toBe('This account has no profile photo.');
    });
  });
});
