-- The `role` column on `users` — 'user' | 'admin'.
--
-- Purely additive: one column with a DEFAULT, one CHECK, and one targeted UPDATE. No backfill loop,
-- no column changes type or nullability, and nothing is dropped. The DEFAULT is what assigns every
-- existing row and every future signup the 'user' role, so no application code states it.
--
-- Scope. This migration adds the column and promotes one existing operator account so the
-- already-built admin navigation can be exercised end to end. It adds no admin surface: no route,
-- guard, or query reads `role` for authorization, and no code path other than this file writes it.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "role" VARCHAR(16) NOT NULL DEFAULT 'user';

-- Prisma cannot express CHECK constraints, so this is written by hand. It is invisible to the
-- schema file and to `prisma migrate diff`, which is why it is documented in schema.prisma's
-- comment on the column rather than only here.
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("role" IN ('user', 'admin'));

-- The one operator account, promoted by address.
--
-- Matched on the normalised `email` column: addresses are stored trim+lowercase (a CHECK pins the
-- invariant), so an exact comparison is the whole match — no `lower()` wrapper, and the unique index
-- serves it. Idempotent, and a no-op on any database where that account does not exist.
--
-- THIS RUNS ONCE. A migration is not a policy: an account registered on a fresh database after this
-- has applied comes up as 'user' like every other, and promoting it is a manual UPDATE until the
-- planned `admin:grant` script exists (admin_role_plan.md §13.1). The alternative — reading an
-- address from the environment at boot — was declined there, because it silently re-promotes a
-- deliberately demoted account on every deploy.
UPDATE "users" SET "role" = 'admin' WHERE "email" = 'iqbalarslan009@gmail.com';
