import { Injectable } from '@nestjs/common';
import type { AdminIdentityRow } from '../common/types/admin.types';
import type { AuthIdentityRecord } from '../common/types/oauth.types';
import type { OAuthProvider } from '../domain/oauth';
import { PrismaService } from '../database/prisma.service';

/*
 * The only component allowed to read or write `auth_identities` (ADR-020).
 *
 * Note what is not here: no `findByEmail`. `email_at_link` is audit material, and a lookup method
 * on it would eventually be used as one — at which point a user who changed their Google address
 * would be resolved to whoever holds the old one. The absence is the safeguard.
 */

export interface CreateAuthIdentityInput {
  readonly userId: string;
  readonly provider: OAuthProvider;
  readonly providerSubject: string;
  readonly emailAtLink: string | null;
}

export type CreateAuthIdentityResult =
  | { readonly ok: true; readonly identity: AuthIdentityRecord }
  /** A unique index refused it: either that provider account or that user already has an identity. */
  | { readonly ok: false };

/** Prisma's unique-constraint failure, detected structurally so no ORM type escapes this file. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

interface AuthIdentityRow {
  id: string;
  userId: string;
  provider: string;
  providerSubject: string;
  emailAtLink: string | null;
  linkedAt: Date;
  lastLoginAt: Date | null;
}

function toRecord(row: AuthIdentityRow): AuthIdentityRecord {
  return {
    id: row.id,
    userId: row.userId,
    // Narrowed by the database: `auth_identities_provider_check` restricts the column to the same
    // list `OAUTH_PROVIDERS` declares, so a row can hold nothing this type cannot describe.
    provider: row.provider as OAuthProvider,
    providerSubject: row.providerSubject,
    emailAtLink: row.emailAtLink,
    linkedAt: row.linkedAt,
    lastLoginAt: row.lastLoginAt,
  };
}

@Injectable()
export class AuthIdentityRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The sign-in lookup, and the only way an identity is ever resolved.
   *
   * Keyed on the provider's `sub` rather than on an email, because `sub` is the thing that does not
   * change. A user who moves their Google account to a new address is still the same person here.
   */
  async findByProviderSubject(
    provider: OAuthProvider,
    providerSubject: string,
  ): Promise<AuthIdentityRecord | null> {
    const row = await this.prisma.authIdentity.findUnique({
      where: { provider_providerSubject: { provider, providerSubject } },
    });
    return row === null ? null : toRecord(row);
  }

  /**
   * Link a provider account to an existing Evergrove account.
   *
   * No pre-check, for the reason `UserRepository.create` gives: between a check and an insert
   * another request can claim the same pair, so the unique indexes are the only race-free
   * authority. A refusal here is information, not an error.
   */
  async create(input: CreateAuthIdentityInput): Promise<CreateAuthIdentityResult> {
    try {
      const row = await this.prisma.authIdentity.create({ data: { ...input } });
      return { ok: true, identity: toRecord(row) };
    } catch (error) {
      if (isUniqueViolation(error)) return { ok: false };
      throw error;
    }
  }

  /** Records that this identity was used. Forensic only — nothing reads it to make a decision. */
  /**
   * The account's linked providers, for the admin detail view (`admin_role_plan.md` §6.2).
   *
   * A DIFFERENT PROJECTION FROM `AuthIdentityRecord`, AND THAT IS THE WHOLE REASON IT EXISTS. That
   * record carries `providerSubject` and `emailAtLink` — the provider's opaque identity key and the
   * address it asserted at link time — and §6.2 excludes both from every admin response. Reusing the
   * record here and trusting a caller to drop two fields would make the exclusion a convention;
   * selecting three columns makes it a fact about the query.
   *
   * Ordered oldest first, so the list reads as the account's history of linking rather than in
   * whatever order the planner returns.
   */
  async listForAdmin(userId: string): Promise<AdminIdentityRow[]> {
    return this.prisma.authIdentity.findMany({
      where: { userId },
      orderBy: { linkedAt: 'asc' },
      select: { provider: true, linkedAt: true, lastLoginAt: true },
    });
  }

  async touchLastLogin(id: string, at: Date): Promise<void> {
    await this.prisma.authIdentity.update({ where: { id }, data: { lastLoginAt: at } });
  }
}
