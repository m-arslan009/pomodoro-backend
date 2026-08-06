import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { ReportFrequency } from '../domain/report';

/*
 * The only component allowed to read or write `report_deliveries` (ADR-020) — the delivery ledger.
 *
 * IT IS SHAPED LIKE A QUEUE TABLE ON PURPOSE. A2 declined `pg-boss` while the job list has exactly
 * one entry on it, and ADR-014 rev. 2 records the trigger for adopting it: a second background job.
 * Claim, attempt count, next-attempt time and terminal states are the columns a queue would have
 * needed anyway, so that migration is a port rather than a rewrite.
 *
 * Its consumer is the worker, which is phase R5. It ships now because the idempotency guarantee
 * lives here rather than in the worker — `claimPeriod` below is A7 — and a ledger written after the
 * thing that depends on it is a ledger written to fit whatever the worker happened to do.
 */

export type DeliveryStatus =
  'pending' | 'sent' | 'failed' | 'retryable' | 'skipped_empty' | 'abandoned';

export interface DeliveryRecord {
  readonly id: string;
  readonly subscriptionId: string;
  readonly periodKind: ReportFrequency;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly providerMessageId: string | null;
  readonly lastError: string | null;
  readonly generatedAt: Date | null;
}

export interface ClaimPeriodInput {
  readonly subscriptionId: string;
  readonly periodKind: ReportFrequency;
  readonly periodStart: Date;
  readonly periodEnd: Date;
}

/** Prisma's unique-constraint violation. Here it means "this period is already accounted for". */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

const SELECT = {
  id: true,
  subscriptionId: true,
  periodKind: true,
  periodStart: true,
  periodEnd: true,
  status: true,
  attempts: true,
  nextAttemptAt: true,
  providerMessageId: true,
  lastError: true,
  generatedAt: true,
} as const;

/** Provider messages can be long and can quote an address; the column is 500 and so is this. */
const MAX_ERROR_LENGTH = 500;

@Injectable()
export class ReportDeliveryRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Claim a period for delivery. **This is the idempotency design (A7).**
   *
   * With no queue, safety comes from the database: the unique index on
   * `(subscription, kind, period_start)` means the second caller to try the same period loses the
   * insert and is told so. A tick that fires twice, a cron provider that retries, two overlapping
   * deploys — all of them collapse to one row and one report.
   *
   * The row is written **before** the document is rendered, so a crash mid-render leaves a `pending`
   * row the retry pass can find rather than no evidence at all.
   *
   * @returns the claimed row, or null when this period is already accounted for.
   */
  async claimPeriod(input: ClaimPeriodInput): Promise<DeliveryRecord | null> {
    try {
      return (await this.prisma.reportDelivery.create({
        data: { ...input, status: 'pending', attempts: 0 },
        select: SELECT,
      })) as DeliveryRecord;
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  /** The provider accepted the message. `providerMessageId` is what a bounce webhook joins on. */
  async markSent(id: string, providerMessageId: string | null, generatedAt: Date): Promise<void> {
    await this.prisma.reportDelivery.update({
      where: { id },
      data: {
        status: 'sent',
        providerMessageId,
        generatedAt,
        nextAttemptAt: null,
        lastError: null,
        attempts: { increment: 1 },
      },
    });
  }

  /**
   * The attempt failed and is worth another (§26.3).
   *
   * The caller decides `nextAttemptAt`, because backoff is a policy and this is a repository. What
   * is enforced here is that a retryable row is the only kind that carries one — a `next_attempt_at`
   * on a sent row would be read by the retry pass as work to do, and would re-send a report that
   * already arrived. A CHECK constraint says the same thing in the database.
   */
  async markRetryable(id: string, nextAttemptAt: Date, error: string): Promise<void> {
    await this.prisma.reportDelivery.update({
      where: { id },
      data: {
        status: 'retryable',
        nextAttemptAt,
        lastError: error.slice(0, MAX_ERROR_LENGTH),
        attempts: { increment: 1 },
      },
    });
  }

  /** Terminal. `failed` is a 4xx that would only repeat; `abandoned` is the attempt ceiling. */
  async markTerminal(id: string, status: 'failed' | 'abandoned', error: string): Promise<void> {
    await this.prisma.reportDelivery.update({
      where: { id },
      data: {
        status,
        nextAttemptAt: null,
        lastError: error.slice(0, MAX_ERROR_LENGTH),
        attempts: { increment: 1 },
      },
    });
  }

  /**
   * The period held no focus sessions, so nothing was sent (P7).
   *
   * Recorded rather than skipped silently: without a row the next tick would resolve the same
   * period, find it empty, and decide again — forever. The decision is the record.
   */
  async markSkippedEmpty(id: string): Promise<void> {
    await this.prisma.reportDelivery.update({
      where: { id },
      data: { status: 'skipped_empty', nextAttemptAt: null },
    });
  }

  /** Work the retry pass should pick up on this tick. Bounded, like every other pass (D5). */
  async findRetryable(now: Date, limit: number): Promise<DeliveryRecord[]> {
    return this.prisma.reportDelivery.findMany({
      where: { status: 'retryable', nextAttemptAt: { lte: now } },
      orderBy: { nextAttemptAt: 'asc' },
      take: limit,
      select: SELECT,
    }) as Promise<DeliveryRecord[]>;
  }

  /**
   * Retention (L4). Hygiene on a path that is already writing — the same shape
   * `auth-session.repository.ts` uses, and the reason ADR-014's original objection to scheduled work
   * does not apply to it: missing a sweep costs nothing.
   */
  async purgeOlderThan(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.reportDelivery.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return count;
  }
}
