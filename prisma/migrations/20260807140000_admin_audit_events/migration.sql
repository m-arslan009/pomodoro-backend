-- `admin_audit_events` — the record of every administrative write.
--
-- Purely additive: one new table, three indexes, one CHECK. No existing column changes type or
-- nullability, nothing is dropped, and no backfill runs. Existing rows in `users` are untouched.
--
-- WHY IT COMES FIRST. `admin_role_plan.md` §5.1 and CONTRACT.md §31 both state that no admin route
-- may mutate anything until this table exists — an unaudited administrative write is the single
-- thing that design is arranged to prevent. Disable, reactivate, revoke-sessions, role change and
-- deletion all write a row here inside the same transaction as their state change, so an action
-- that succeeded is always recorded and one that rolled back is never recorded as having happened.
--
-- ON DELETE SET NULL, NOT CASCADE. Every other child of `users` in this schema cascades. This one
-- deliberately does not: cascading would mean deleting an account erases the record that it was
-- deleted. The email snapshots beside each foreign key are what keep the row readable afterwards —
-- the same pattern as `focus_sessions.task_title_snapshot`, stored verbatim and never re-derived.

-- CreateTable
CREATE TABLE "admin_audit_events" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID,
    "actor_email_snapshot" VARCHAR(320) NOT NULL,
    "target_user_id" UUID,
    "target_email_snapshot" VARCHAR(320),
    "action" VARCHAR(48) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "request_id" VARCHAR(64),
    "ip" VARCHAR(45),
    "user_agent" VARCHAR(512),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_events_pkey" PRIMARY KEY ("id")
);

-- Prisma cannot express CHECK constraints, so this is written by hand — the same treatment
-- `users_role_check` gets, and documented on the model in schema.prisma for the same reason.
--
-- It pins the action vocabulary to `domain/admin-audit.ts`. A typo in an action name would
-- otherwise produce a row that no filter ever matches, which is an audit entry that exists and
-- cannot be found.
ALTER TABLE "admin_audit_events" ADD CONSTRAINT "admin_audit_events_action_check" CHECK (
    "action" IN (
        'user.disabled',
        'user.reactivated',
        'user.role_changed',
        'user.sessions_revoked',
        'user.deleted'
    )
);

-- CreateIndex
--
-- The feed's own order, newest first, with the id breaking ties so a cursor page boundary cannot
-- silently drop or repeat a row. Matches `ORDER BY created_at DESC, id DESC` exactly.
CREATE INDEX "admin_audit_events_created_at_id_idx" ON "admin_audit_events"("created_at" DESC, "id" DESC);

-- "Everything done to this account" — how one user's history is read.
CREATE INDEX "admin_audit_events_target_user_id_created_at_idx" ON "admin_audit_events"("target_user_id", "created_at" DESC);

-- "Everything this operator did."
CREATE INDEX "admin_audit_events_actor_user_id_created_at_idx" ON "admin_audit_events"("actor_user_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "admin_audit_events" ADD CONSTRAINT "admin_audit_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audit_events" ADD CONSTRAINT "admin_audit_events_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
