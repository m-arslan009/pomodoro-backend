-- Identity storage for provider sign-in (ADR-008a, CONTRACT.md §1.5).
--
-- Non-destructive in both halves. Dropping NOT NULL widens a column: no existing row changes, no
-- data is lost, and every account that exists today still carries a hash — so the null branch is
-- unreachable for all of them and every current sign-in behaves identically.
--
-- There is deliberately **no** cross-table CHECK enforcing "an account has a password or an
-- identity". Postgres cannot express that without a trigger, and the invariant is readable in the
-- service instead: `DELETE /me/identities/:provider` is its single enforcement point (§4.16).

-- Null means "created through a provider, no password set". Every password-verifying path must
-- treat it as a value that can never match, and must still pay the dummy-verify cost so that
-- response timing does not distinguish it from a wrong password.
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;

CREATE TABLE "auth_identities" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "provider_subject" VARCHAR(255) NOT NULL,
    "email_at_link" VARCHAR(320),
    "linked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "auth_identities_pkey" PRIMARY KEY ("id")
);

-- The sign-in lookup path, and the guarantee that one Google account cannot reach two Evergrove
-- accounts. This index is the reason branch 3a of §4.12.1 never has to consult an email address.
CREATE UNIQUE INDEX "auth_identities_provider_subject_key"
  ON "auth_identities"("provider", "provider_subject");

-- At most one identity per provider per account.
CREATE UNIQUE INDEX "auth_identities_user_provider_key"
  ON "auth_identities"("user_id", "provider");

-- Listing the caller's identities, and the cascade's own lookup.
CREATE INDEX "auth_identities_user_id_idx" ON "auth_identities"("user_id");

ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Google is the only supported provider. Widening this is a migration a reviewer reads, which is
-- the point: a second provider needs its own `email_verified` judgement before §4.12.1 branch 3b-ii
-- may apply to it, and that judgement must not be reachable by an accidental string.
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_provider_check"
  CHECK ("provider" IN ('google'));
