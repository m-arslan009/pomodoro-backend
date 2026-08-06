import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { Env } from '../config/env.schema';

/**
 * The header the external scheduler presents. **Never a query parameter** — `pino-http` serialises
 * request URLs, and §9.7 is this codebase's record of what happens when a credential rides in one.
 */
export const WORKER_TOKEN_HEADER = 'x-reports-token';

/**
 * Guards the report worker trigger (CONTRACT.md §25.5).
 *
 * The one route in the application that no user authenticates to and that can cause outbound mail
 * to every subscriber, so three things are true of it by construction:
 *
 *   - **No secret configured means the route is shut**, not open. A deployment that has not set
 *     `REPORTS_WORKER_SECRET` cannot be triggered at all, rather than being triggerable by anyone.
 *   - The comparison is constant-time, so the endpoint is not an oracle for guessing the secret.
 *   - It takes **no user id**, in any form. ADR-010 is not weakened by a batch route that has no
 *     way to name a victim.
 */
@Injectable()
export class WorkerSecretGuard implements CanActivate {
  private readonly secret: Buffer | null;

  constructor(config: ConfigService<Env, true>) {
    const configured = config.get('REPORTS_WORKER_SECRET', { infer: true });
    this.secret = configured ? Buffer.from(configured, 'utf8') : null;
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.secret) throw new UnauthorizedException();

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers[WORKER_TOKEN_HEADER];
    const presented = typeof header === 'string' ? Buffer.from(header, 'utf8') : null;

    /*
     * Length is checked first because `timingSafeEqual` throws on a mismatch. That does leak the
     * secret's length, which is not worth defending: it is a fixed-length value chosen by the
     * operator, not a password, and padding to hide it would add a failure mode for no gain.
     */
    if (!presented || presented.length !== this.secret.length) throw new UnauthorizedException();
    if (!timingSafeEqual(presented, this.secret)) throw new UnauthorizedException();

    return true;
  }
}
