import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

/**
 * Liveness probe (ADR-016). Excluded from the global `/api/v1` prefix and from throttling, so
 * an uptime pinger cannot exhaust the rate limit for real traffic.
 *
 * Deliberately does not touch the database: this answers "is the process up", and a readiness
 * check that fails on a slow query would restart a healthy container.
 */
@Controller('health')
@SkipThrottle()
export class HealthController {
  @Get()
  check(): { status: string; uptime: number } {
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }
}
