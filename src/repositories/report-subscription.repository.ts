import { Injectable } from '@nestjs/common';
import type { DueSubscriptionRecord, ReportSubscriptionRecord } from '../common/types/report.types';
import { PrismaService } from '../database/prisma.service';
import type { ReportFrequency, SubscriptionStatus } from '../domain/report';

/*
 * The only component allowed to read or write `report_subscriptions` (ADR-020).
 *
 * Every user-facing method takes the user id as a query constraint rather than checking ownership
 * afterwards — there is no code path by which a caller could address another account's subscription
 * (ADR-010). The two token lookups are the deliberate exception and are discussed at each.
 */

/** Everything a write may set. Absent keys are left alone. */
export interface SubscriptionPatch {
  readonly frequency?: ReportFrequency;
  readonly status?: SubscriptionStatus;
  readonly deliveryDay?: number;
  readonly pausedUntil?: Date | null;
  readonly confirmedAt?: Date | null;
  readonly confirmationTokenHash?: string | null;
  readonly confirmationExpiresAt?: Date | null;
  readonly unsubscribeTokenHash?: string;
  readonly consecutiveSoftBounces?: number;
  readonly lastBounceAt?: Date | null;
}

export interface CreateSubscriptionInput {
  readonly userId: string;
  readonly frequency: ReportFrequency;
  readonly status: SubscriptionStatus;
  readonly deliveryDay: number;
  readonly confirmedAt: Date | null;
  readonly confirmationTokenHash: string | null;
  readonly confirmationExpiresAt: Date | null;
  readonly unsubscribeTokenHash: string;
}

/** Prisma's foreign-key violation — the account was deleted between authenticating and saving. */
function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2003';
}

const SELECT = {
  id: true,
  userId: true,
  frequency: true,
  status: true,
  deliveryDay: true,
  pausedUntil: true,
  confirmedAt: true,
  confirmationTokenHash: true,
  confirmationExpiresAt: true,
  unsubscribeTokenHash: true,
  consecutiveSoftBounces: true,
  lastBounceAt: true,
  lastDeliveredPeriodStart: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class ReportSubscriptionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Null when the account has never answered.
   *
   * **Reading never creates the row**, exactly as `user_settings` does not — but the reason is
   * stronger here. A read that created a row would destroy the distinction the whole feature turns
   * on: no row means "never asked", and once something writes a row on a read, every account looks
   * as though it has been asked and the one-time invitation never appears again (§23.0
   * consequence 3).
   */
  async findByUserId(userId: string): Promise<ReportSubscriptionRecord | null> {
    return this.prisma.reportSubscription.findUnique({
      where: { userId },
      select: SELECT,
    }) as Promise<ReportSubscriptionRecord | null>;
  }

  /** @returns null when the account no longer exists. */
  async create(input: CreateSubscriptionInput): Promise<ReportSubscriptionRecord | null> {
    try {
      return (await this.prisma.reportSubscription.create({
        data: { ...input },
        select: SELECT,
      })) as ReportSubscriptionRecord;
    } catch (error) {
      if (isForeignKeyViolation(error)) return null;
      throw error;
    }
  }

  async update(userId: string, patch: SubscriptionPatch): Promise<ReportSubscriptionRecord> {
    return this.prisma.reportSubscription.update({
      where: { userId },
      data: { ...patch },
      select: SELECT,
    }) as Promise<ReportSubscriptionRecord>;
  }

  /**
   * Find a subscription by the hash of a token it was sent.
   *
   * The two token finders below are the only reads in this repository not scoped to a user id, and
   * that is not a hole in ADR-010: the token *is* the credential, it is unguessable, and the caller
   * is by definition not signed in — the link is opened from an email, often on a device that never
   * has been. Looking up by hash rather than by the token means a database dump does not hand
   * anybody a working link.
   */
  async findByConfirmationTokenHash(hash: string): Promise<ReportSubscriptionRecord | null> {
    return this.prisma.reportSubscription.findFirst({
      where: { confirmationTokenHash: hash },
      select: SELECT,
    }) as Promise<ReportSubscriptionRecord | null>;
  }

  async findByUnsubscribeTokenHash(hash: string): Promise<ReportSubscriptionRecord | null> {
    return this.prisma.reportSubscription.findFirst({
      where: { unsubscribeTokenHash: hash },
      select: SELECT,
    }) as Promise<ReportSubscriptionRecord | null>;
  }

  /** The webhook's join: whose subscription does this accepted message belong to? */
  async findByDeliveryMessageId(messageId: string): Promise<ReportSubscriptionRecord | null> {
    const delivery = await this.prisma.reportDelivery.findFirst({
      where: { providerMessageId: messageId },
      select: { subscription: { select: SELECT } },
    });
    return (delivery?.subscription ?? null) as ReportSubscriptionRecord | null;
  }

  /**
   * Candidate subscriptions for this hourly tick, joined to the account's zone.
   *
   * **The join is the timezone rule made structural.** There is no timezone column on this table
   * (§23.0 consequence 1), so `users.timezone` travels with every candidate and the caller decides
   * dueness in the account's own zone rather than the server's. A subscription whose user row
   * somehow has no zone cannot occur — the column is `NOT NULL DEFAULT 'UTC'`.
   *
   * The filter here is deliberately coarse: status and frequency narrow it to an index scan, and
   * the local-hour and local-day test happens in the domain, because SQL cannot express
   * "8am wherever this person lives" without a timezone expression per row (§23.0 A3 refuses that).
   * `take` bounds the pass so it finishes inside one request (D5).
   */
  async findDeliverable(
    frequency: ReportFrequency,
    limit: number,
  ): Promise<DueSubscriptionRecord[]> {
    const rows = await this.prisma.reportSubscription.findMany({
      where: { status: 'active', frequency },
      orderBy: { lastDeliveredPeriodStart: { sort: 'asc', nulls: 'first' } },
      take: limit,
      select: {
        ...SELECT,
        user: { select: { timezone: true, email: true, firstName: true } },
      },
    });

    return rows.map(({ user, ...subscription }) => ({
      ...(subscription as ReportSubscriptionRecord),
      timeZone: user.timezone,
      email: user.email,
      firstName: user.firstName,
    }));
  }

  /**
   * One subscription with its account's zone attached, by subscription id.
   *
   * The retry pass's read. It re-checks the subscription rather than trusting the delivery row,
   * because the attempt being retried may be hours old and the user may have unsubscribed in the
   * meantime — mailing somebody who has since asked us not to is worse than losing the retry.
   */
  async findDueById(id: string): Promise<DueSubscriptionRecord | null> {
    const row = await this.prisma.reportSubscription.findUnique({
      where: { id },
      select: {
        ...SELECT,
        user: { select: { timezone: true, email: true, firstName: true } },
      },
    });
    if (!row) return null;

    const { user, ...subscription } = row;
    return {
      ...(subscription as ReportSubscriptionRecord),
      timeZone: user.timezone,
      email: user.email,
      firstName: user.firstName,
    };
  }

  /** Records that a period has been delivered, for the cheap "already covered?" read. */
  async markPeriodDelivered(id: string, periodStart: Date): Promise<void> {
    await this.prisma.reportSubscription.update({
      where: { id },
      data: { lastDeliveredPeriodStart: periodStart, consecutiveSoftBounces: 0 },
    });
  }

  /** A message reached the recipient. The soft-bounce counter starts again from zero. */
  async recordDelivered(id: string): Promise<void> {
    await this.prisma.reportSubscription.update({
      where: { id },
      data: { consecutiveSoftBounces: 0 },
    });
  }

  /**
   * A transient bounce. Increments the counter and returns the new value so the caller can decide
   * whether the limit has been reached.
   *
   * Incremented in the database rather than read-modify-written in Node: two bounces arriving at
   * once would otherwise both read the same value and one increment would be lost.
   */
  async recordSoftBounce(id: string, at: Date): Promise<number> {
    const row = await this.prisma.reportSubscription.update({
      where: { id },
      data: { consecutiveSoftBounces: { increment: 1 }, lastBounceAt: at },
      select: { consecutiveSoftBounces: true },
    });
    return row.consecutiveSoftBounces;
  }

  /** Too many transient failures in a row. Reports stop until the user asks for them again. */
  async pauseUntil(id: string, until: Date): Promise<void> {
    await this.prisma.reportSubscription.update({
      where: { id },
      data: { status: 'paused', pausedUntil: until },
    });
  }

  /**
   * Stop future reports permanently — a hard bounce, a suppression, or a complaint (L3, §25.6).
   *
   * `bounced` and `unsubscribed` are both terminal for delivery and are kept apart because they are
   * different facts: one says the address does not work, the other says the person objected. Only
   * the first is a reason to question the address on the account.
   */
  async disable(id: string, status: 'bounced' | 'unsubscribed', at: Date): Promise<void> {
    await this.prisma.reportSubscription.update({
      where: { id },
      data: {
        status,
        pausedUntil: null,
        ...(status === 'bounced' ? { lastBounceAt: at } : {}),
      },
    });
  }
}
