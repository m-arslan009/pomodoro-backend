import { Injectable } from '@nestjs/common';
import type { PreferencesPatch, SettingsRecord } from '../common/types/settings.types';
import { PrismaService } from '../database/prisma.service';
import {
  DEFAULT_BREAK_MINUTES,
  DEFAULT_THEME,
  DEFAULT_WORK_MINUTES,
  type Theme,
} from '../domain/settings';

/*
 * The only component allowed to read or write the user_settings table (ADR-020).
 *
 * Every method takes the user id as a query constraint rather than checking ownership after the
 * fact — there is no code path by which a caller could address another account's row (ADR-010).
 */

export interface UpdateSettingsInput {
  readonly workMinutes?: number;
  readonly breakMinutes?: number;
  readonly theme?: Theme;
  readonly preferences: PreferencesPatch;
}

/** The row as Postgres returns it from the upsert. */
interface SettingsRow {
  readonly work_minutes: number;
  readonly break_minutes: number;
  readonly theme: string;
  readonly preferences: unknown;
  readonly updated_at: Date;
}

/** Prisma's foreign-key violation — the account was deleted between authenticating and saving. */
function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2003';
}

@Injectable()
export class SettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Null when the account has never saved a preference. Reading never creates the row. */
  async findByUserId(userId: string): Promise<SettingsRecord | null> {
    return this.prisma.userSettings.findUnique({
      where: { userId },
      select: {
        workMinutes: true,
        breakMinutes: true,
        theme: true,
        preferences: true,
        updatedAt: true,
      },
    });
  }

  /**
   * Upsert the changed keys and return the whole row.
   *
   * Hand-written SQL rather than `prisma.userSettings.upsert` for one reason: the JSONB blob has
   * to be *merged*, and Prisma cannot express Postgres's `||` operator on a Json column. The
   * alternative — read the blob, merge it in Node, write it back — is a read-modify-write that
   * loses one of two concurrent section saves under Read Committed. That is precisely the
   * last-write-wins behaviour PATCH was chosen over PUT to avoid (CONTRACT.md §4.8), so
   * reintroducing it in the implementation would defeat the endpoint's design.
   *
   * As one statement this is atomic without a transaction, an isolation level, or a retry loop.
   * Absent scalars COALESCE to the stored value on conflict, and to the domain default on insert.
   *
   * @returns null when the account no longer exists.
   */
  async upsert(userId: string, input: UpdateSettingsInput): Promise<SettingsRecord | null> {
    const fragment = JSON.stringify(input.preferences);
    const work = input.workMinutes ?? null;
    const brk = input.breakMinutes ?? null;
    const theme = input.theme ?? null;

    try {
      const rows = await this.prisma.$queryRaw<SettingsRow[]>`
        INSERT INTO user_settings
          (user_id, work_minutes, break_minutes, theme, preferences, created_at, updated_at)
        VALUES (
          ${userId}::uuid,
          COALESCE(${work}::smallint, ${DEFAULT_WORK_MINUTES}::smallint),
          COALESCE(${brk}::smallint, ${DEFAULT_BREAK_MINUTES}::smallint),
          COALESCE(${theme}::varchar, ${DEFAULT_THEME}::varchar),
          ${fragment}::jsonb,
          now(),
          now()
        )
        ON CONFLICT (user_id) DO UPDATE SET
          work_minutes  = COALESCE(${work}::smallint, user_settings.work_minutes),
          break_minutes = COALESCE(${brk}::smallint, user_settings.break_minutes),
          theme         = COALESCE(${theme}::varchar, user_settings.theme),
          preferences   = user_settings.preferences || ${fragment}::jsonb,
          updated_at    = now()
        RETURNING work_minutes, break_minutes, theme, preferences, updated_at
      `;

      const row = rows[0];
      if (!row) return null;

      return {
        workMinutes: row.work_minutes,
        breakMinutes: row.break_minutes,
        theme: row.theme,
        preferences: row.preferences,
        updatedAt: row.updated_at,
      };
    } catch (error) {
      if (isForeignKeyViolation(error)) return null;
      throw error;
    }
  }
}
