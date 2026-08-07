-- The admin account directory: `users.disabled_at`, plus the index its list read sorts on.
--
-- Purely additive, like the `role` migration before it. One nullable column with no default, one
-- new index, no backfill, no column changes type or nullability, and nothing is dropped. Every
-- existing row gets NULL, which reads as 'active' — the correct status for an account nobody has
-- ever disabled.
--
-- Scope. This supports `GET /admin/users` and nothing else. No code path writes `disabled_at`:
-- disable and reactivate are `admin_role_plan.md` §6.4/§6.5 and are not built, so the column is
-- currently read-only in practice as well as in intent. Critically, **no guard consults it** —
-- `JwtGuard`, login, refresh and the OAuth callback are untouched, so a row with a `disabled_at` set
-- by hand would still be able to sign in. The column records a fact; it does not yet withhold
-- anything.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "disabled_at" TIMESTAMPTZ(3);

-- CreateIndex
--
-- Descending on both columns, matching `ORDER BY created_at DESC, id DESC` exactly, so the keyset
-- page is an index scan in its natural direction rather than a backwards walk.
--
-- The tie-breaking `id` is part of the index and not only part of the cursor: without it, two
-- accounts sharing a `created_at` have no stable order, and an unstable order is how a cursor page
-- boundary silently drops or repeats a row.
CREATE INDEX "users_created_at_id_idx" ON "users"("created_at" DESC, "id" DESC);
