-- Drops server-side sessions.
--
-- Authentication is now a single self-contained access token: the server signs it, verifies it,
-- and keeps no record of it. Nothing reads `auth_sessions` any more — the refresh endpoint that
-- was its only consumer is gone, and `JwtGuard` never consulted it — so the table is dropped
-- rather than left behind to accumulate rows nobody queries.
--
-- DESTRUCTIVE and irreversible: every stored session is deleted. Applying this signs out every
-- user with a live refresh cookie, and there is no downgrade path back to those rows. That is
-- the intended outcome — under the new model those cookies are meaningless anyway.
--
-- The indexes, the unique constraint on token_hash and the foreign key to users are all removed
-- implicitly by DROP TABLE. The users table, including password_changed_at and last_login_at,
-- is untouched.

DROP TABLE "auth_sessions";
