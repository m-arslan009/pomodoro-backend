import { Body, Controller, Get, HttpStatus, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentAuth } from '../common/decorators/current-auth.decorator';
import type { GamificationSnapshot, Session } from '../common/types/session.types';
import type { AuthContext } from '../common/types/user.types';
import {
  type ListSessionsQueryDto,
  type RecordSessionDto,
  listSessionsQuerySchema,
  recordSessionSchema,
} from '../dto/session.dto';
import { JwtGuard } from '../guards/jwt.guard';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { SessionService } from '../services/session.service';

/**
 * The focus event log (CONTRACT.md §16.5, §16.6).
 *
 * `POST /sessions` is deliberately RPC-flavoured: it is a command that returns a recomputed
 * projection. REST purity is not the goal here — a single round trip is. The client finishes a
 * block, sends it, and receives both the stored record and its new totals, so a session never costs
 * two requests and the two answers can never disagree with each other.
 *
 * There is no PATCH and no DELETE, now or ever: the log is append-only (ADR-006). A correction
 * would be a compensating record, not an edit.
 */
@Controller('sessions')
@UseGuards(JwtGuard)
export class SessionController {
  constructor(private readonly sessions: SessionService) {}

  /**
   * Record a finished interval.
   *
   * **201** when the record is new, **200** when this exact `clientSessionId` was already stored.
   * That distinction is the outbox contract: a retried flush is SUCCESS, and answering 409 would
   * make a client treat its own retry as an error and stop retrying. A 409 is reserved for a
   * genuinely different session claiming the same instant.
   */
  @Post()
  async record(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(recordSessionSchema)) dto: RecordSessionDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ session: Session; gamification: GamificationSnapshot }> {
    const { session, gamification, replayed } = await this.sessions.recordSession(
      auth.userId,
      // Day attribution is user-local, and the token already carries the account's zone — so the
      // streak is computed against the user's calendar without a second query for it.
      auth.profile.timezone,
      dto,
    );

    response.status(replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return { session, gamification };
  }

  /**
   * The hydration read: one page of history, newest first, defaulting to the 180-day window the
   * client's widest chart covers.
   *
   * This is the ONLY read History needs. There are no statistics endpoints — the client aggregates
   * these records itself, so summaries, timelines and outcome breakdowns cost no further requests
   * and cannot drift from the log they describe.
   */
  @Get()
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listSessionsQuerySchema)) query: ListSessionsQueryDto,
  ): Promise<{ sessions: Session[]; nextCursor: string | null }> {
    return this.sessions.listSessions(auth.userId, query);
  }
}
