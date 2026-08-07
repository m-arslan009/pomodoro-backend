/*
 * The three rules that bound what an administrator may do to an account — pure, framework-free,
 * ORM-free (enforced by eslint on src/domain).
 *
 * They live here rather than inside `AdminUserService` for the reason every rule in this folder
 * does: they are decisions, they are exhaustively testable without a database, and a rule expressed
 * as an `if` in the middle of a transaction is a rule nobody can find later.
 *
 * ALL THREE ARE CONFLICTS, NOT VALIDATION FAILURES. Every one of them refuses a *well-formed*
 * request — the body is valid, the target exists, the caller is an administrator, and the action is
 * still not allowed. That maps to 409, never 422 (ADR-016's `ConflictError` / `DomainRuleError`
 * rather than `ValidationError`), and the distinction matters to the client: a 422 tells a form
 * which field to fix, and there is no field to fix here.
 *
 * WHY THEY EXIST AT ALL, stated once so they are not "simplified" away:
 *
 *   1 & 2 remove self-inflicted lockout. An operator who demotes or disables themselves in a
 *     single-operator system has no recovery path — promotion is a deploy-shell operation, and
 *     ADR-009's account-recovery flow is unbuilt. The two rules make the mistake unexpressible on
 *     the only routes that can write those columns.
 *   3 keeps the system from reaching zero administrators, which is the same lockout arrived at from
 *     the other direction: the bootstrap script is a deploy-shell operation and must not become the
 *     routine way back in.
 *
 * THE CLIENT MIRRORS RULES 1 AND 2 AND CANNOT MIRROR RULE 3. The admin UI disables the controls it
 * knows are forbidden — it holds the signed-in account's id, so self-target is knowable — but it has
 * no administrator count and therefore offers the demotion that rule 3 refuses. That is the correct
 * split: the client saves a round trip where it can, and this file is what actually decides.
 */

import type { AdminUserRole } from './admin-user';

/** Why an administrative action was refused. One value per rule, so the caller can word it. */
export type RoleRuleViolation =
  | 'self_role_change'
  | 'self_disable'
  | 'self_delete'
  | 'self_session_revoke'
  | 'last_admin'
  /** Not one of the three rules, but the same shape and status — see `refusesPromotion`. */
  | 'promotion_blocked';

/** The facts a rule needs about the account being acted on. Deliberately not a database row. */
export interface RoleRuleTarget {
  readonly id: string;
  readonly role: AdminUserRole;
  readonly disabled: boolean;
  /** Whether the account can sign in at all: a password, a linked identity, or both. */
  readonly hasCredential: boolean;
}

/**
 * Rule 1 — an administrator may not change their own role.
 *
 * It makes "elevate myself" unexpressible on the one route that writes the column, and removes
 * self-demotion by accident. Note that it fires on a *no-op* self-change too: refusing
 * `PATCH {role: 'admin'}` against your own already-admin account costs nothing and keeps the rule a
 * single comparison rather than a comparison plus an exception.
 *
 * @param actorId The signed-in administrator.
 * @param targetId The account being changed.
 */
export function refusesSelfRoleChange(actorId: string, targetId: string): boolean {
  return actorId === targetId;
}

/** Rule 2, disable half — an administrator may not disable their own account. */
export function refusesSelfDisable(actorId: string, targetId: string): boolean {
  return actorId === targetId;
}

/** Rule 2, delete half — an administrator may not delete their own account. */
export function refusesSelfDelete(actorId: string, targetId: string): boolean {
  return actorId === targetId;
}

/**
 * Not one of the three, but the same shape and the same status.
 *
 * An administrator cutting their own refresh sessions is asking for `POST /auth/logout`, which does
 * exactly that and rotates nothing out from under the request in flight. Refusing here keeps the
 * admin routes free of an action that has a correct home elsewhere (`admin_role_plan.md` §6.6).
 */
export function refusesSelfSessionRevoke(actorId: string, targetId: string): boolean {
  return actorId === targetId;
}

/**
 * Rule 3 — the last remaining administrator may not be demoted or disabled.
 *
 * `adminCount` is the number of accounts currently holding `role = 'admin'`, **counted inside the
 * same transaction as the write**. Counting outside it would leave a window in which two concurrent
 * demotions each see two administrators, each conclude they are not the last, and together empty
 * the set — the exact race this rule exists to prevent.
 *
 * A disabled administrator still counts. That is deliberate and it is why disabling an
 * administrator is bounded by this rule at all: an account that cannot sign in is not an operator,
 * so the rule must consider the *effective* set. Counting only active administrators would let the
 * set be emptied by disabling them one at a time, each disable seeing the previous one still in the
 * count. Keeping disabled admins in the count means the last one cannot be disabled either, which
 * is the same guarantee stated once.
 *
 * @param target The account being demoted or disabled.
 * @param adminCount How many accounts hold the admin role right now.
 */
export function refusesLastAdmin(target: RoleRuleTarget, adminCount: number): boolean {
  return target.role === 'admin' && adminCount <= 1;
}

/**
 * §6.7's extra control on promotion: the target must be able to sign in.
 *
 * Promoting a disabled account, or one with no password and no linked identity, creates an
 * administrator who cannot sign in — and whom rule 3 will then refuse to demote, because they still
 * count toward the administrator set. The two rules together would turn one careless promotion into
 * a permanent phantom operator, so the promotion is refused instead.
 *
 * Only promotion is checked. A demotion of a disabled account is fine: it reduces privilege.
 */
export function refusesPromotion(target: RoleRuleTarget, nextRole: AdminUserRole): boolean {
  if (nextRole !== 'admin' || target.role === 'admin') return false;
  return target.disabled || !target.hasCredential;
}
