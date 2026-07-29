import { Injectable } from '@nestjs/common';
import {
  conflictProblem,
  invalidCredentialsProblem,
  notAuthenticatedProblem,
  validationProblem,
  type FieldError,
} from '../common/errors/problem.exception';
import { Clock } from '../common/ports/clock.port';
import { PasswordHasher } from '../common/ports/password-hasher.port';
import {
  type AuthContext,
  type UserProfile,
  type UserRecord,
  toUserProfile,
} from '../common/types/user.types';
import { classifyIdentifier, normalizeUsername, usernameKey } from '../domain/identifier';
import { checkPassword, describePasswordViolation } from '../domain/password-policy';
import { DEFAULT_TIMEZONE } from '../domain/timezone';
import type { ChangePasswordDto, LoginDto, RegisterDto } from '../dto/auth.dto';
import { UserRepository, type UserConflictField } from '../repositories/user.repository';
import { AccessTokenService } from './access-token.service';

/**
 * Everything a controller needs to answer an authentication request: one identity and one
 * credential.
 *
 * The access token is the whole credential — there is no second half in a cookie. It appears in
 * the body precisely because JavaScript has to attach it to the next request; it belongs in the
 * client's memory, never in storage.
 */
export interface AuthResult {
  readonly profile: UserProfile;
  readonly accessToken: string;
  /** Milliseconds until the access token expires, after which the user must sign in again. */
  readonly accessTokenExpiresIn: number;
}

const CONFLICT_MESSAGES: Record<UserConflictField, FieldError> = {
  email: { field: 'email', message: 'An account with this email already exists.' },
  username: { field: 'username', message: 'That username is already taken.' },
};

/**
 * Use-case orchestration for authentication.
 *
 * Owns no rules of its own: identifier resolution and password policy come from src/domain, and
 * all persistence goes through repositories. What lives here is the *sequence* — and the
 * security-critical ordering decisions that sequence encodes.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly clock: Clock,
    private readonly accessTokens: AccessTokenService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResult> {
    // Checked here rather than in the DTO because the rule compares the password against the
    // other fields, and the same rule must apply on change-password where they are not present.
    const violation = checkPassword(dto.password, { username: dto.username, email: dto.email });
    if (violation) {
      throw validationProblem([
        { field: 'password', message: describePasswordViolation(violation) },
      ]);
    }

    const passwordHash = await this.hasher.hash(dto.password);
    const username = normalizeUsername(dto.username);

    const created = await this.users.create({
      email: dto.email,
      username,
      usernameLower: usernameKey(username),
      firstName: dto.firstName,
      lastName: dto.lastName,
      passwordHash,
      timezone: dto.timezone ?? DEFAULT_TIMEZONE,
    });

    if (!created.ok) {
      throw conflictProblem(created.conflicts.map((field) => CONFLICT_MESSAGES[field]));
    }

    return this.issueAccessToken(created.user);
  }

  /**
   * Verify a credential pair and issue an access token.
   *
   * Three details here are the anti-enumeration design, not incidental style:
   *  1. the identifier is resolved to a column without being validated, so a malformed value
   *     fails as "invalid credentials" rather than as a validation error;
   *  2. an unknown account still pays for a full Argon2 verification, so response *timing* does
   *     not distinguish it from a wrong password;
   *  3. both failure paths raise the identical problem response.
   */
  async login(dto: LoginDto): Promise<AuthResult> {
    const identifier = classifyIdentifier(dto.identifier);

    const user =
      identifier.kind === 'email'
        ? await this.users.findByEmail(identifier.value)
        : await this.users.findByUsernameKey(identifier.value);

    if (!user) {
      await this.hasher.verifyDummy(dto.password);
      throw invalidCredentialsProblem();
    }

    if (!(await this.hasher.verify(user.passwordHash, dto.password))) {
      throw invalidCredentialsProblem();
    }

    // The one moment the plaintext is available under proven-correct conditions, so it is the
    // only moment an outdated hash can be transparently upgraded.
    if (this.hasher.needsRehash(user.passwordHash)) {
      await this.users.updatePasswordHashOnly(user.id, await this.hasher.hash(dto.password));
    }

    await this.users.markLogin(user.id, this.clock.now());
    return this.issueAccessToken(user);
  }

  /**
   * Change the password and hand this device a new access token.
   *
   * Note what this does *not* do: tokens already issued to other devices keep working until they
   * expire. Without a session table there is nothing to revoke, so `password_changed_at` is
   * recorded for audit and a future security panel, but no guard consults it. Changing a
   * password after a compromise therefore locks the attacker out of *signing in*, not out of the
   * token they already hold — for up to JWT_ACCESS_TTL_MS.
   *
   * The caller is re-issued because it is free to do so here and it keeps the user signed in on
   * the device they just used.
   */
  async changePassword(auth: AuthContext, dto: ChangePasswordDto): Promise<AuthResult> {
    const user = await this.users.findById(auth.userId);
    if (!user) throw notAuthenticatedProblem();

    if (!(await this.hasher.verify(user.passwordHash, dto.currentPassword))) {
      throw validationProblem([
        { field: 'currentPassword', message: 'That is not your current password.' },
      ]);
    }

    if (dto.newPassword === dto.currentPassword) {
      throw validationProblem([
        { field: 'newPassword', message: 'Choose a password different from your current one.' },
      ]);
    }

    const violation = checkPassword(dto.newPassword, {
      username: user.username,
      email: user.email,
    });
    if (violation) {
      throw validationProblem([
        { field: 'newPassword', message: describePasswordViolation(violation) },
      ]);
    }

    await this.users.updatePassword(
      user.id,
      await this.hasher.hash(dto.newPassword),
      this.clock.now(),
    );

    return this.issueAccessToken(user);
  }

  /** The one place a credential is minted, so every successful flow answers the same shape. */
  private async issueAccessToken(user: UserRecord): Promise<AuthResult> {
    const access = await this.accessTokens.issue(user.id);

    return {
      profile: toUserProfile(user),
      accessToken: access.token,
      accessTokenExpiresIn: access.expiresInMs,
    };
  }
}
