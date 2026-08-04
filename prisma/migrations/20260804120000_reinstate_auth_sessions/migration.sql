-- Reinstates `auth_sessions`, reversing `20260729120000_drop_auth_sessions` (ADR-008 rev. 3).
--
-- The shape is `20260728120000_identity_and_sessions`'s, unchanged: every column that existed then
-- earns its place now, and nothing is added. `absolute_expires_at` is the inherited ceiling that
-- makes the 30-day cap real; `revoked_at` is retained on rotation rather than deleted, which is what
-- makes a replayed token distinguishable from an unknown one.
--
-- No backfill and no data migration. The drop took the rows with it, so there is nothing to restore
-- — every currently signed-in user signs in once more. Non-destructive: it only creates.

CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "user_agent" VARCHAR(512),
    "ip" VARCHAR(45),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- Both the lookup path (a presented token is hashed and matched here) and the collision guard.
CREATE UNIQUE INDEX "auth_sessions_token_hash_key" ON "auth_sessions"("token_hash");

-- Revoke-all-for-user: password change, and reuse detection.
CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions"("user_id");

-- The opportunistic purge on login.
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions"("expires_at");

ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The idle window may never outlive the absolute ceiling. Enforced in the database as well as in
-- `src/domain/auth-session.ts`, because ceiling inheritance is the one invariant whose failure is
-- silent: a session that quietly stopped inheriting still works, it just never expires.
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_expiry_within_ceiling"
  CHECK ("expires_at" <= "absolute_expires_at");
