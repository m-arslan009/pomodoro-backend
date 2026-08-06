import {
  type ReportFrequency,
  type SubscriptionState,
  type SubscriptionStatus,
  UNASKED,
} from '../../domain/report';

/*
 * Plain shapes that cross layer boundaries, and the one place "no row" becomes a state.
 *
 * Repositories map Prisma rows onto these before returning them, so no ORM type reaches a service
 * or a controller — the same rule user.types.ts follows and for the same reason (ADR-004).
 */

/** The stored row as the repository reads it. Includes token material; never leaves the service. */
export interface ReportSubscriptionRecord {
  readonly id: string;
  readonly userId: string;
  readonly frequency: ReportFrequency;
  readonly status: SubscriptionStatus;
  readonly deliveryDay: number;
  readonly pausedUntil: Date | null;
  readonly confirmedAt: Date | null;
  readonly confirmationTokenHash: string | null;
  readonly confirmationExpiresAt: Date | null;
  readonly unsubscribeTokenHash: string;
  readonly consecutiveSoftBounces: number;
  readonly lastBounceAt: Date | null;
  readonly lastDeliveredPeriodStart: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * A subscription joined to the one thing on `users` it needs: the account's zone.
 *
 * The join is the point. `report_subscriptions` has no timezone column (§23.0 consequence 1), so
 * the only way to resolve a period or a delivery hour is to read `users.timezone` — and doing it
 * here, in the query that selects due work, means no caller is in a position to forget.
 */
export interface DueSubscriptionRecord extends ReportSubscriptionRecord {
  readonly timeZone: string;
  readonly email: string;
  readonly firstName: string;
}

/**
 * What the API returns for a subscription (CONTRACT.md §25.1).
 *
 * NO TOKEN HASH, NO BOUNCE COUNT, NO ERROR TEXT. Delivery state is operational and stays server-
 * side; what the client needs is what it can act on.
 */
export interface ReportSubscriptionView {
  readonly status: SubscriptionState;
  readonly frequency: ReportFrequency | null;
  readonly deliveryDay: number | null;
  readonly confirmedAt: string | null;
  /** True while a confirmation link is outstanding, so the UI can say what it is waiting for. */
  readonly requiresConfirmation: boolean;
}

/**
 * The answer for an account with no row.
 *
 * **This is a 200, not a 404.** A missing subscription means the question has never been put to the
 * account — the permanent state of every Google-created account until it opens Settings — and a
 * client that received a 404 would have to guess whether that meant "never asked" or "no such user".
 * Returning a state instead is what lets the frontend render the three options rather than an error
 * (§25.1).
 */
export const UNASKED_SUBSCRIPTION: ReportSubscriptionView = {
  status: UNASKED,
  frequency: null,
  deliveryDay: null,
  confirmedAt: null,
  requiresConfirmation: false,
};

/** Flatten a stored row into the API shape. A missing row is the `unasked` state, never a 404. */
export function toReportSubscriptionView(
  record: ReportSubscriptionRecord | null,
): ReportSubscriptionView {
  if (!record) return UNASKED_SUBSCRIPTION;

  return {
    status: record.status,
    frequency: record.frequency,
    /*
     * Only meaningful for a weekly subscription — a monthly one is always the 1st, and reporting a
     * weekday for it would invite a client to render a control for a choice that does not exist.
     */
    deliveryDay: record.frequency === 'weekly' ? record.deliveryDay : null,
    confirmedAt: record.confirmedAt?.toISOString() ?? null,
    requiresConfirmation: record.status === 'pending_confirmation',
  };
}
