import { Injectable } from '@nestjs/common';
import { notAuthenticatedProblem } from '../common/errors/problem.exception';
import {
  type PreferencesPatch,
  type UserSettings,
  toUserSettings,
} from '../common/types/settings.types';
import type { UpdateSettingsDto } from '../dto/settings.dto';
import { SettingsRepository } from '../repositories/settings.repository';

/**
 * Preference reads and writes for the signed-in account.
 *
 * Thin by design (ADR-005): settings is CRUD with no invariants beyond the ones the DTO already
 * enforces, so the only work here is the column/JSONB split — which exists in the database and
 * must not reach the client (CONTRACT.md §1.4).
 */
@Injectable()
export class SettingsService {
  constructor(private readonly settings: SettingsRepository) {}

  /** Domain defaults when no row exists. An account that has changed nothing is not a 404. */
  async getSettings(userId: string): Promise<UserSettings> {
    return toUserSettings(await this.settings.findByUserId(userId));
  }

  async updateSettings(userId: string, dto: UpdateSettingsDto): Promise<UserSettings> {
    /*
     * Only keys the client actually sent are forwarded. An explicit `undefined` would serialise
     * to nothing useful in the JSONB fragment, whereas an absent key leaves the stored value
     * untouched — which is what makes a per-section save additive.
     *
     * `customTheme: null` is deliberately preserved rather than stripped: null is the value that
     * clears the palette override, not the absence of one.
     */
    const preferences: PreferencesPatch = {
      ...(dto.customTheme === undefined ? {} : { customTheme: dto.customTheme }),
      ...(dto.background === undefined ? {} : { background: dto.background }),
      ...(dto.labels === undefined ? {} : { labels: dto.labels }),
    };

    const record = await this.settings.upsert(userId, {
      workMinutes: dto.workMinutes,
      breakMinutes: dto.breakMinutes,
      theme: dto.theme,
      preferences,
    });

    // The token verified, then the account vanished mid-request. There is nothing to sign in as.
    if (!record) throw notAuthenticatedProblem();

    return toUserSettings(record);
  }
}
