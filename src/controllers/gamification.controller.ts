import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentAuth } from '../common/decorators/current-auth.decorator';
import type { GamificationSnapshot } from '../common/types/session.types';
import type { AuthContext } from '../common/types/user.types';
import { JwtGuard } from '../guards/jwt.guard';
import { GamificationService } from '../services/gamification.service';

/**
 * The signed-in account's progression (CONTRACT.md §16.7).
 *
 * Read-only, and the only route that exposes the projection on its own. Every write path runs
 * through recording a session, because points exist only as a consequence of work: an endpoint that
 * could set them would be an endpoint that could grant titles.
 *
 * `POST /sessions` already returns this object, so the client needs this route only at sign-in, to
 * seed state before any session has been recorded in that browser.
 */
@Controller('gamification')
@UseGuards(JwtGuard)
export class GamificationController {
  constructor(private readonly gamification: GamificationService) {}

  @Get()
  async read(@CurrentAuth() auth: AuthContext): Promise<{ gamification: GamificationSnapshot }> {
    return { gamification: await this.gamification.getGamification(auth.userId) };
  }
}
