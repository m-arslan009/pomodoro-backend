import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { notAuthenticatedProblem } from '../common/errors/problem.exception';
import type { AuthenticatedRequest } from '../common/types/authenticated-request';
import { toUserProfile } from '../common/types/user.types';
import { UserRepository } from '../repositories/user.repository';
import { AccessTokenService } from '../services/access-token.service';

/*
 * Turns an `Authorization: Bearer <jwt>` header into an authenticated request, or refuses it.
 *
 * Every rejection raises the identical problem — no header, wrong scheme, bad signature,
 * expired, wrong issuer or audience, deleted account. There is deliberately no branch that
 * distinguishes them, because "your token expired" and "no such user" are different sentences
 * and the difference is exactly what an attacker probes for. The client is told only that it is
 * not authenticated, and its single recovery is to sign in again.
 *
 * The profile is read here rather than carried in the token (see AccessTokenService): the token
 * asserts *who*, the database answers *what they look like now*.
 */
@Injectable()
export class JwtGuard implements CanActivate {
  constructor(
    private readonly tokens: AccessTokenService,
    private readonly users: UserRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const presented = readBearerToken(request.headers.authorization);
    if (!presented) throw notAuthenticatedProblem();

    const claims = await this.tokens.verify(presented);
    if (!claims) throw notAuthenticatedProblem();

    /*
     * The only server-side state consulted is the account itself. There is no session record to
     * check, so a valid token authenticates until it expires — deleting the account is the one
     * thing that stops it early, and that is a side effect of needing the profile, not a
     * revocation mechanism. JWT_ACCESS_TTL_MS is what bounds a compromise.
     */
    const user = await this.users.findById(claims.userId);
    if (!user) throw notAuthenticatedProblem();

    request.auth = {
      userId: user.id,
      profile: toUserProfile(user),
    };

    return true;
  }
}

/**
 * The credential out of an Authorization header, or null.
 *
 * The scheme is matched case-insensitively because RFC 7235 says it is case-insensitive, and a
 * client sending `bearer` is not an attack — but anything that is not exactly one scheme and one
 * token is refused rather than salvaged.
 */
function readBearerToken(header: string | undefined): string | null {
  if (!header) return null;

  const [scheme, token, ...rest] = header.trim().split(/\s+/);
  if (rest.length > 0) return null;
  if (scheme?.toLowerCase() !== 'bearer') return null;

  return token && token.length > 0 ? token : null;
}
