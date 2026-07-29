import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest } from '../types/authenticated-request';
import type { AuthContext } from '../types/user.types';

/**
 * Hands a controller the identity JwtGuard resolved, so handlers never reach into the raw
 * request object. Only valid on routes guarded by JwtGuard — without it, `auth` is absent.
 */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().auth,
);
