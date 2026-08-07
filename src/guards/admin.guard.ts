import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { routeNotFoundProblem } from '../common/errors/problem.exception';
import type { AuthenticatedRequest } from '../common/types/authenticated-request';

/*
 * Refuses every request from an account that is not an administrator — by pretending the route does
 * not exist.
 *
 * IT RUNS AFTER JwtGuard AND HAS NO ANONYMOUS BRANCH, on purpose. `request.auth` is populated by
 * JwtGuard and nowhere else, so this guard is only ever correct in second position:
 * `@UseGuards(JwtGuard, AdminGuard)`. Nest runs controller guards in the order they are listed, so
 * an unauthenticated caller has already been answered 401 before this executes. The optional chain
 * below is a safety net for a misordered decorator, not a supported path — it fails closed, which is
 * the only acceptable way for an authorization check to be wrong.
 *
 * 404, NEVER 403. A 403 would confirm that `/admin/users` is a real endpoint and that some accounts
 * can reach it; a 404 tells a probing account exactly what a typo tells it. See
 * `routeNotFoundProblem` for why the rendered body has to match an unmatched route down to the
 * capitalisation.
 *
 * THIS IS THE BOUNDARY. The frontend's `services/admin.js` decides which navigation to draw, and
 * `RequireAdmin` decides which page to mount — both run in a browser the user controls, and neither
 * protects anything. Authorization is this file plus the role on the row JwtGuard just read, and the
 * role is re-read from the database on every request rather than carried in the token, so demoting
 * an account takes effect on its next call rather than when its access token expires.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // Exact match on the narrowed union, never a truthiness test: `toUserProfile` has already mapped
    // anything that is not exactly 'admin' to 'user', and this re-states the same refusal to guess.
    if (request.auth?.profile.role !== 'admin') throw routeNotFoundProblem();

    return true;
  }
}
