-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'todo',
    "estimated_pomodoros" SMALLINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "focus_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "task_id" UUID,
    "task_title_snapshot" VARCHAR(120) NOT NULL,
    "client_session_id" UUID NOT NULL,
    "type" VARCHAR(8) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attribution_date" DATE NOT NULL,
    "planned_duration_ms" INTEGER NOT NULL,
    "actual_duration_ms" INTEGER NOT NULL,
    "termination_reason" VARCHAR(20),
    "points_awarded" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "focus_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_gamification" (
    "user_id" UUID NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "lifetime_points" INTEGER NOT NULL DEFAULT 0,
    "current_day_streak" INTEGER NOT NULL DEFAULT 0,
    "longest_day_streak" INTEGER NOT NULL DEFAULT 0,
    "current_session_run" SMALLINT NOT NULL DEFAULT 0,
    "last_active_date" DATE,
    "streak_freezes_available" SMALLINT NOT NULL DEFAULT 1,
    "last_freeze_granted_on" DATE,
    "unlocked_titles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_gamification_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
-- Deliberately NOT partial on status='todo': hydration fetches every status so History can break
-- down task outcomes, and a partial index would not serve that read.
CREATE INDEX "tasks_user_id_created_at_idx" ON "tasks"("user_id", "created_at" DESC);

-- CreateIndex
-- A retried outbox flush must resolve to the SAME row, which is what makes replay safe.
CREATE UNIQUE INDEX "focus_sessions_user_id_client_session_id_key" ON "focus_sessions"("user_id", "client_session_id");

-- CreateIndex
-- Two records claiming one instant is a genuine conflict, not a replay.
CREATE UNIQUE INDEX "focus_sessions_user_id_started_at_key" ON "focus_sessions"("user_id", "started_at");

-- CreateIndex
-- The dominant read: the hydration query, newest first.
CREATE INDEX "focus_sessions_user_id_started_at_idx" ON "focus_sessions"("user_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "focus_sessions_user_id_task_id_idx" ON "focus_sessions"("user_id", "task_id");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- SET NULL, never CASCADE: deleting a task must not delete the history of work done against it.
-- The title snapshot on each session is what preserves the meaning once this goes null.
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_gamification" ADD CONSTRAINT "user_gamification_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma cannot express CHECK constraints, so these are written by hand. They are invisible to
-- the schema file but real in the database, which is the point: the application is not the last
-- line of defence for an invariant the data model depends on.

-- A task is todo, completed or abandoned. There is no 'expired'.
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_check" CHECK ("status" IN ('todo', 'completed', 'abandoned'));

-- completed_at is set if and only if the task is completed. Reopening clears it.
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_at_check" CHECK (("status" = 'completed') = ("completed_at" IS NOT NULL));

ALTER TABLE "tasks" ADD CONSTRAINT "tasks_title_not_blank_check" CHECK (length(btrim("title")) > 0);

ALTER TABLE "tasks" ADD CONSTRAINT "tasks_estimated_pomodoros_check" CHECK ("estimated_pomodoros" IS NULL OR ("estimated_pomodoros" BETWEEN 1 AND 20));

ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_type_check" CHECK ("type" IN ('focus', 'break'));

ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_status_check" CHECK ("status" IN ('completed', 'terminated'));

ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_termination_reason_check" CHECK ("termination_reason" IS NULL OR "termination_reason" IN ('interrupted', 'wrong_task', 'finished_early', 'out_of_energy'));

-- A reason only makes sense on a termination.
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_reason_requires_terminated_check" CHECK ("termination_reason" IS NULL OR "status" = 'terminated');

ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_interval_check" CHECK ("ended_at" > "started_at");

ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_planned_duration_check" CHECK ("planned_duration_ms" > 0);

-- The reported focused time cannot exceed the wall clock it happened in. This is the constraint
-- that makes "I paused for an hour and focused for two" impossible to store, even if every layer
-- of the application above it were bypassed.
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_actual_duration_check" CHECK ("actual_duration_ms" >= 0 AND "actual_duration_ms" <= "planned_duration_ms" AND "actual_duration_ms" <= EXTRACT(EPOCH FROM ("ended_at" - "started_at")) * 1000);

ALTER TABLE "user_gamification" ADD CONSTRAINT "user_gamification_non_negative_check" CHECK ("balance" >= 0 AND "lifetime_points" >= 0 AND "current_day_streak" >= 0 AND "longest_day_streak" >= 0 AND "current_session_run" >= 0);
