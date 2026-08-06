import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

/*
 * The only component allowed to read or write `report_webhook_events` (ADR-020).
 *
 * One job: decide, exactly once, whether an event has already been handled.
 */

/** Prisma's unique-constraint violation. Here it means "somebody already claimed this event". */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

@Injectable()
export class ReportWebhookEventRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Claim an event for processing. **The insert is the lock.**
   *
   * Every webhook provider retries, and one of this feature's effects — the consecutive soft-bounce
   * counter — is not idempotent. Without this claim, a single transient bounce redelivered three
   * times would pause a perfectly healthy subscription, and the operator would have no way to tell
   * that from three genuine bounces.
   *
   * Racing callers are settled by the unique index rather than by a read-then-write, which under
   * Read Committed would let two concurrent redeliveries both see "not yet handled".
   *
   * @returns true when this caller owns the event, false when it was already claimed.
   */
  async claim(eventId: string, eventType: string): Promise<boolean> {
    try {
      await this.prisma.reportWebhookEvent.create({ data: { eventId, eventType } });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  /** Retention (L4). Swept on the worker's own pass, like the deliveries these events describe. */
  async purgeOlderThan(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.reportWebhookEvent.deleteMany({
      where: { receivedAt: { lt: cutoff } },
    });
    return count;
  }
}
