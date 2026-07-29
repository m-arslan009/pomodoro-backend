import type { Request } from 'express';
import type { AuthContext } from './user.types';

/** A request that has passed JwtGuard. `auth` is populated there and nowhere else. */
export interface AuthenticatedRequest extends Request {
  auth: AuthContext;
}
