import { Injectable } from '@nestjs/common';
import {
  notAuthenticatedProblem,
  notFoundProblem,
  validationProblem,
} from '../common/errors/problem.exception';
import { Clock } from '../common/ports/clock.port';
import { type UserProfile, toUserProfile } from '../common/types/user.types';
import { AVATAR_MAX_DIMENSION, type ImageViolation, sniffImage } from '../domain/image';
import { type AvatarRecord, UserAvatarRepository } from '../repositories/user-avatar.repository';
import { UserRepository } from '../repositories/user.repository';

/** What the client is uploading. Declared here because multer ships no type definitions. */
export interface UploadedImage {
  readonly buffer: Buffer;
  readonly size: number;
}

const VIOLATION_MESSAGES: Record<ImageViolation, string> = {
  empty: 'That file is empty.',
  too_large: 'That image is larger than 256 KB.',
  unsupported_format: 'Use a PNG, JPEG, or WebP image.',
  corrupt: 'That image could not be read.',
  dimensions_too_large: `That image is larger than ${AVATAR_MAX_DIMENSION}×${AVATAR_MAX_DIMENSION} pixels.`,
};

/**
 * The signed-in account's profile photo.
 *
 * Ownership is not checked anywhere in here, because it cannot be violated: every method takes the
 * id the guard read off a verified token, and no route accepts one from the caller (ADR-010).
 */
@Injectable()
export class AvatarService {
  constructor(
    private readonly avatars: UserAvatarRepository,
    private readonly users: UserRepository,
    private readonly clock: Clock,
  ) {}

  async replace(userId: string, file: UploadedImage | undefined): Promise<UserProfile> {
    if (!file) {
      throw validationProblem([{ field: 'avatar', message: 'Choose an image to upload.' }]);
    }

    // What the request claimed the file was is ignored entirely; the bytes decide.
    const sniffed = sniffImage(file.buffer);
    if (!sniffed.ok) {
      throw validationProblem([
        { field: 'avatar', message: VIOLATION_MESSAGES[sniffed.violation] },
      ]);
    }

    const stored = await this.avatars.replace(
      userId,
      {
        data: new Uint8Array(file.buffer),
        contentType: sniffed.format,
        byteSize: file.buffer.byteLength,
        width: sniffed.width,
        height: sniffed.height,
      },
      this.clock.now(),
    );
    if (!stored) throw notAuthenticatedProblem();

    const user = await this.users.findById(userId);
    if (!user) throw notAuthenticatedProblem();

    return toUserProfile(user);
  }

  /**
   * Deletes the photo and falls the account back to its initials.
   *
   * Idempotent: an account with no avatar is already in the requested state, so this succeeds and
   * returns the unchanged profile rather than reporting a 404 the caller could do nothing about.
   */
  async remove(userId: string): Promise<UserProfile> {
    const cleared = await this.avatars.remove(userId);
    if (!cleared) throw notAuthenticatedProblem();

    const user = await this.users.findById(userId);
    if (!user) throw notAuthenticatedProblem();

    return toUserProfile(user);
  }

  async read(userId: string): Promise<AvatarRecord> {
    const avatar = await this.avatars.findByUserId(userId);
    if (!avatar) throw notFoundProblem('This account has no profile photo.');
    return avatar;
  }
}
