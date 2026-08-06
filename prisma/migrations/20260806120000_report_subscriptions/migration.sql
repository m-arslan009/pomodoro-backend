-- Periodic email reports (CONTRACT.md §23.1, §23.2).
--
-- Two tables and nothing else. No column is added to `users` or `user_settings`: the subscription
-- is its own thing with its own lifecycle, and the timezone it needs already exists on `users` as
-- the single interpretation key (§1.3) — copying it here is what §23.0 consequence 1 refuses.

-- CreateTable
CREATE TABLE "report_subscriptions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "frequency" VARCHAR(16) NOT NULL,
    "status" VARCHAR(24) NOT NULL,
    "delivery_day" SMALLINT NOT NULL DEFAULT 1,
    "paused_until" TIMESTAMPTZ(3),
    "confirmed_at" TIMESTAMPTZ(3),
    "confirmation_token_hash" VARCHAR(64),
    "confirmation_expires_at" TIMESTAMPTZ(3),
    "unsubscribe_token_hash" VARCHAR(64) NOT NULL,
    "consecutive_soft_bounces" SMALLINT NOT NULL DEFAULT 0,
    "last_bounce_at" TIMESTAMPTZ(3),
    "last_delivered_period_start" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "report_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_deliveries" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "period_kind" VARCHAR(16) NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3),
    "provider_message_id" VARCHAR(255),
    "last_error" VARCHAR(500),
    "generated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "report_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "report_subscriptions_user_id_key" ON "report_subscriptions"("user_id");

-- CreateIndex
CREATE INDEX "report_subscriptions_status_frequency_delivery_day_idx" ON "report_subscriptions"("status", "frequency", "delivery_day");

-- CreateIndex
CREATE UNIQUE INDEX "report_deliveries_subscription_id_period_kind_period_start_key" ON "report_deliveries"("subscription_id", "period_kind", "period_start");

-- CreateIndex
CREATE INDEX "report_deliveries_status_next_attempt_at_idx" ON "report_deliveries"("status", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "report_subscriptions" ADD CONSTRAINT "report_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "report_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma cannot express CHECK constraints, so these are written by hand. They are invisible to
-- `prisma migrate diff`, which means they must never be dropped by a later generated migration
-- without being re-added here.

-- The six statuses of §23.1. `declined` and `unsubscribed` are both "off" and both stored: one is
-- an answer given before anything was sent, the other is an answer given by someone who was
-- receiving reports and stopped, and the copy the user reads differs accordingly.
ALTER TABLE "report_subscriptions" ADD CONSTRAINT "report_subscriptions_status_check" CHECK ("status" IN ('pending_confirmation', 'active', 'paused', 'declined', 'unsubscribed', 'bounced'));

ALTER TABLE "report_subscriptions" ADD CONSTRAINT "report_subscriptions_frequency_check" CHECK ("frequency" IN ('weekly', 'monthly'));

-- ISO weekday. Monthly subscriptions ignore it; they are always the 1st.
ALTER TABLE "report_subscriptions" ADD CONSTRAINT "report_subscriptions_delivery_day_check" CHECK ("delivery_day" BETWEEN 1 AND 7);

-- A pending subscription has a live token and an expiry; anything else has neither. Written as one
-- equivalence so the two columns cannot drift apart — a token hash with no expiry would never
-- expire, and an expiry with no hash would be a subscription stuck pending with nothing to confirm.
ALTER TABLE "report_subscriptions" ADD CONSTRAINT "report_subscriptions_confirmation_pair_check" CHECK (("confirmation_token_hash" IS NULL) = ("confirmation_expires_at" IS NULL));

ALTER TABLE "report_subscriptions" ADD CONSTRAINT "report_subscriptions_pending_has_token_check" CHECK ("status" <> 'pending_confirmation' OR "confirmation_token_hash" IS NOT NULL);

-- An active subscription has proven its address. This is L3 as a database invariant rather than as
-- a rule in a service: there is no code path, present or future, that can activate a subscription
-- whose address was never confirmed.
ALTER TABLE "report_subscriptions" ADD CONSTRAINT "report_subscriptions_active_confirmed_check" CHECK ("status" <> 'active' OR "confirmed_at" IS NOT NULL);

ALTER TABLE "report_subscriptions" ADD CONSTRAINT "report_subscriptions_soft_bounces_check" CHECK ("consecutive_soft_bounces" >= 0);

ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_status_check" CHECK ("status" IN ('pending', 'sent', 'failed', 'retryable', 'skipped_empty', 'abandoned'));

ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_period_kind_check" CHECK ("period_kind" IN ('weekly', 'monthly'));

-- Inclusive range, so a single-day period would be equal. A weekly period is 7 days and a monthly
-- one is 28–31, but the constraint states only what must be true of every period.
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_period_range_check" CHECK ("period_end" >= "period_start");

ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_attempts_check" CHECK ("attempts" >= 0);

-- Only a retryable row is waiting for something. A `next_attempt_at` on a sent row would be read by
-- the retry pass as work to do, and would re-send a report that already arrived.
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_next_attempt_check" CHECK ("next_attempt_at" IS NULL OR "status" = 'retryable');
