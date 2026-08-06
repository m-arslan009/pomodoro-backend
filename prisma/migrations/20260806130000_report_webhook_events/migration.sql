-- Webhook event de-duplication (CONTRACT.md §25.6).
--
-- The soft-bounce rule counts, and every webhook provider retries. Without this table one transient
-- bounce delivered three times would pause a perfectly healthy subscription.

-- CreateTable
CREATE TABLE "report_webhook_events" (
    "id" UUID NOT NULL,
    "event_id" VARCHAR(255) NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "report_webhook_events_event_id_key" ON "report_webhook_events"("event_id");

-- CreateIndex
CREATE INDEX "report_webhook_events_received_at_idx" ON "report_webhook_events"("received_at");
