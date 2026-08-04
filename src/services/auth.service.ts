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
import type { DeviceContext, IssuedRefreshToken } from '../common/types/auth-session.types';
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
import { RefreshTokenService } from './refresh-token.service';

/**
 * Everything a controller needs to answer an authentication request: one identity and two
 * credentials (ADR-008 rev. 3).
 *
 * The split is the design. The access token appears in the body because JavaScript has to attach it
 * to the next request, and it belongs in the client's memory and never in storage. The refresh token
 * appears here only so the controller can put it in a `Set-Cookie` — JavaScript never sees it, which
 * is what lets it be long-lived without being the thing an XSS bug walks away with.
 */
export interface AuthResult {
  readonly profile: UserProfile;
  readonly accessToken: string;
  /** Milliseconds until the access token expires, after which the client silently refreshes. */
  readonly accessTokenExpiresIn: number;
  /** Bound for a `Set-Cookie`. The one place the plaintext refresh token exists on this side. */
  readonly refresh: IssuedRefreshToken;
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
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  async register(dto: RegisterDto, device: DeviceContext): Promise<AuthResult> {
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

    return this.startSession(created.user, device);
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
  async login(dto: LoginDto, device: DeviceContext): Promise<AuthResult> {
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
    return this.startSession(user, device);
  }

  /**
   * Exchange a refresh cookie for a new access token, and rotate the cookie.
   *
   * Unauthenticated by design: the access token is exactly the thing that has expired by the time
   * this is called, so requiring one would make the endpoint useless (CONTRACT.md §4 preamble). The
   * cookie is the credential, and `RefreshTokenService` decides whether it is still good.
   *
   * **Every failure raises the identical problem.** Absent, forged, expired, past its ceiling,
   * revoked and replayed all arrive at the same 401, so a caller learns only "not signed in" — the
   * reuse case in particular must not announce itself, or an attacker learns their token was burned.
   */
  async refresh(presented: string | null, device: DeviceContext): Promise<AuthResult> {
    if (presented === null) throw notAuthenticatedProblem();

    const rotated = await this.refreshTokens.rotate(presented, device);
    if (!rotated.ok) throw notAuthenticatedProblem();

    // The session outlived the account only if it was deleted mid-flight; the row cascades, so this
    // is close to unreachable — and it fails closed rather than issuing a token for nobody.
    const user = await this.users.findById(rotated.userId);
    if (!user) throw notAuthenticatedProblem();

    const access = await this.accessTokens.issue(user.id);

    return {
      profile: toUserProfile(user),
      accessToken: access.token,
      accessTokenExpiresIn: access.expiresInMs,
      refresh: rotated.session,
    };
  }

  /** End the session the presented cookie names. Silent about whether it matched anything. */
  async logout(presented: string | null): Promise<void> {
    if (presented === null) return;
    await this.refreshTokens.revoke(presented);
  }

  /**
   * Change the password, sign every other device out, and keep this one signed in.
   *
   * The revocation is the point (ADR-008 rev. 3): every other refresh session dies, so a device
   * that was signed in with the old password cannot renew. The caller's own session is rotated
   * rather than revoked, because signing someone out of the device they just used to secure their
   * account is a punishment for doing the right thing.
   *
   * One limit, stated rather than implied: `JwtGuard` does not read `auth_sessions`, so an *access*
   * token already issued elsewhere keeps working until it expires — at most `JWT_ACCESS_TTL_MS`.
   * That window is why the access TTL is short. `password_changed_at` is still written and still
   * read by nothing; the sessions are the mechanism, the column is the audit record.
   */
  async changePassword(
    auth: AuthContext,
    dto: ChangePasswordDto,
    device: DeviceContext,
  ): Promise<AuthResult> {
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

    /*
     * Revoke everything, then open a fresh session — rather than sparing the caller's and leaving
     * it. Two reasons. Excluding a session means identifying it from the presented cookie, and
     * getting that wrong signs the user out of the device they are holding. And revoking first
     * means the window in which an old session could still refresh is closed before the new one
     * exists, rather than overlapping it. The caller notices nothing: the response carries a new
     * access token and a new cookie.
     */
    await this.refreshTokens.revokeAll(user.id);
    return this.startSession(user, device);
  }

  /**
   * The one place a session begins, so every successful flow answers the same shape and no path can
   * accidentally issue half a credential pair.
   */
  private async startSession(user: UserRecord, device: DeviceContext): Promise<AuthResult> {
    const access = await this.accessTokens.issue(user.id);
    const refresh = await this.refreshTokens.issue(user.id, device);

    return {
      profile: toUserProfile(user),
      accessToken: access.token,
      accessTokenExpiresIn: access.expiresInMs,
      refresh,
    };
  }
}
