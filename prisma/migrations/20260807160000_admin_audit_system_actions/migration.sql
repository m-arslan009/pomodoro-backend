-- Widen `admin_audit_events_action_check` to admit the two system-written actions.
--
-- Purely additive in effect: the constraint accepts a strict superset of what it accepted before, so
-- every existing row still satisfies it and no row is rewritten. No column changes type or
-- nullability, no index changes, no data moves. Postgres must still scan the table once to validate
-- the new constraint, which on an append-only audit table of this size is a single sequential pass.
--
-- WHY IT WAS TOO NARROW. The original constraint mirrored `domain/admin-audit.ts` at the time it was
-- written, and that file listed only the five actions the admin routes write. But
-- `admin_role_plan.md` §5.2 specifies two more, and neither has an administrator behind it:
--
--   admin.bootstrap_granted        — the deploy-shell script that creates the first operator. There
--                                    is no signed-in admin at that moment by definition.
--   security.refresh_reuse_detected — `refresh-token.service.ts`, when a spent refresh token is
--                                    presented again. The system detected it; nobody performed it.
--
-- Until this migration those two writes would have been refused by the database. That is the
-- constraint working exactly as intended — it is what stops a typo producing a row no filter ever
-- matches — and widening it deliberately is the intended way past it, in step with the domain
-- constant and the read DTO's enum.
--
-- The two new values are why `actor_user_id` is nullable. It always was; nothing about the column
-- changes here.

ALTER TABLE "admin_audit_events" DROP CONSTRAINT "admin_audit_events_action_check";

ALTER TABLE "admin_audit_events" ADD CONSTRAINT "admin_audit_events_action_check" CHECK (
    "action" IN (
        'user.disabled',
        'user.reactivated',
        'user.role_changed',
        'user.sessions_revoked',
        'user.deleted',
        'admin.bootstrap_granted',
        'security.refresh_reuse_detected'
    )
);
