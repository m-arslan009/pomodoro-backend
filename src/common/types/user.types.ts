/*
 * Plain shapes that cross layer boundaries.
 *
 * Repositories map Prisma rows onto these before returning them, so no ORM type reaches a
 * service, a guard or a controller. That is what keeps ADR-004's "swap the data-access tool"
 * escape hatch real rather than theoretical.
 */

/** A full account row, including the credential. Never leaves the service layer. */
export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly username: string;
  readonly usernameLower: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly passwordHash: string;
  readonly timezone: string;
  readonly emailVerifiedAt: Date | null;
  readonly passwordChangedAt: Date;
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What the API returns for an account. Contains no credential material by construction. */
export interface UserProfile {
  readonly id: string;
  readonly email: string;
  readonly username: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly timezone: string;
  readonly emailVerified: boolean;
  readonly createdAt: string;
}

/**
 * The projection of an authenticated request's identity.
 *
 * Deliberately holds no password hash: request-scoped state is the wrong place to park
 * credential material, and the one endpoint that needs it re-reads the row.
 */
export interface AuthContext {
  readonly userId: string;
  readonly profile: UserProfile;
}

export function toUserProfile(user: UserRecord): UserProfile {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    timezone: user.timezone,
    // Exposed as a boolean rather than the timestamp: the client only ever needs the state, and
    // shipping it now means the future verification banner needs no contract change.
    emailVerified: user.emailVerifiedAt !== null,
    createdAt: user.createdAt.toISOString(),
  };
}
