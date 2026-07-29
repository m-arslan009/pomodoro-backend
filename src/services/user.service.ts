import { Injectable } from '@nestjs/common';
import { conflictProblem, notAuthenticatedProblem } from '../common/errors/problem.exception';
import { type UserProfile, toUserProfile } from '../common/types/user.types';
import { normalizeUsername, usernameKey } from '../domain/identifier';
import type { UpdateProfileDto } from '../dto/user.dto';
import { UserRepository } from '../repositories/user.repository';

/**
 * Profile reads and writes for the signed-in account.
 *
 * Kept separate from AuthService because the concerns differ: this one never touches
 * credentials or sessions. It exists in the same module because both operate on the identity
 * aggregate.
 */
@Injectable()
export class UserService {
  constructor(private readonly users: UserRepository) {}

  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<UserProfile> {
    // A username change must move its uniqueness key in the same write, or the CHECK constraint
    // rejects the row — which is exactly the protection it exists to provide.
    const username = dto.username === undefined ? undefined : normalizeUsername(dto.username);

    const result = await this.users.updateProfile(userId, {
      firstName: dto.firstName,
      lastName: dto.lastName,
      username,
      usernameLower: username === undefined ? undefined : usernameKey(username),
      timezone: dto.timezone,
    });

    if (!result.ok) {
      throw conflictProblem([{ field: 'username', message: 'That username is already taken.' }]);
    }
    if (!result.user) throw notAuthenticatedProblem();

    return toUserProfile(result.user);
  }
}
