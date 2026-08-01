import { Module } from '@nestjs/common';
import { GamificationController } from '../controllers/gamification.controller';
import { SessionController } from '../controllers/session.controller';
import { SessionRepository } from '../repositories/session.repository';
import { GamificationService } from '../services/gamification.service';
import { SessionService } from '../services/session.service';
import { AuthModule } from './auth.module';
import { TaskModule } from './task.module';

/*
 * The focus event log and the progression it produces.
 *
 * Gamification lives here rather than in a module of its own because it is not an independent
 * feature: `user_gamification` is a projection of `focus_sessions`, updated inside the same
 * transaction as the insert (ADR-006), and rebuilt from the same log. Separating them would put a
 * transaction boundary between two things that must commit together.
 *
 * TaskModule is imported for one question — does this task belong to this account — so the session
 * recorder never touches the tasks table itself.
 *
 * GamificationService is exported for the `gamification:rebuild` command. SessionRepository is not
 * exported: nothing outside this module may write the log or the projection.
 */
@Module({
  imports: [AuthModule, TaskModule],
  controllers: [SessionController, GamificationController],
  providers: [SessionService, GamificationService, SessionRepository],
  exports: [GamificationService],
})
export class SessionModule {}
