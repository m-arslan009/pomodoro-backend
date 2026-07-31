import { z } from 'zod';
import {
  BACKGROUNDS,
  BREAK_MINUTES_MAX,
  BREAK_MINUTES_MIN,
  HEX_COLOR_PATTERN,
  LABEL_MAX_LENGTH,
  THEMES,
  WORK_MINUTES_MAX,
  WORK_MINUTES_MIN,
} from '../domain/settings';

/*
 * Preference updates. Every field is optional — this is a PATCH, and the Settings page saves one
 * section at a time (CONTRACT.md §4.8).
 *
 * Every rule is imported from src/domain rather than restated, so the API boundary and the
 * business rules cannot drift apart, and the same constants are mirrored in the frontend.
 */

const minutesSchema = (label: string, min: number, max: number) =>
  z
    .number()
    .int(`${label} must be a whole number of minutes.`)
    .min(min, `${label} must be between ${min} and ${max} minutes.`)
    .max(max, `${label} must be between ${min} and ${max} minutes.`);

const hexColorSchema = z.string().regex(HEX_COLOR_PATTERN, 'Use a six-digit hex colour.');

/*
 * All three colours or nothing. A partial palette would leave the client guessing which CSS
 * variables it still owns, and `null` already expresses "clear the override" unambiguously.
 *
 * strictObject rejects unknown keys rather than silently dropping them: a typo'd colour name that
 * validated and then did nothing is the failure mode this schema exists to prevent.
 */
const customThemeSchema = z.strictObject({
  accent: hexColorSchema,
  leaf: hexColorSchema,
  wood: hexColorSchema,
});

/** Trimmed here, at the boundary, so everything downstream receives the canonical value. */
const labelSchema = z
  .string()
  .trim()
  .max(LABEL_MAX_LENGTH, `Labels must be ${LABEL_MAX_LENGTH} characters or fewer.`);

export const updateSettingsSchema = z
  .strictObject({
    workMinutes: minutesSchema('Focus session', WORK_MINUTES_MIN, WORK_MINUTES_MAX).optional(),
    breakMinutes: minutesSchema('Short break', BREAK_MINUTES_MIN, BREAK_MINUTES_MAX).optional(),
    theme: z.enum(THEMES, 'Choose a supported theme.').optional(),
    // Nullable, not optional-only: null is the value that clears the palette override.
    customTheme: customThemeSchema.nullable().optional(),
    background: z.enum(BACKGROUNDS, 'Choose a supported background.').optional(),
    // Replaced whole, never merged key-by-key — both labels always travel together.
    labels: z.strictObject({ work: labelSchema, break: labelSchema }).optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Provide at least one setting to update.',
  });

export type UpdateSettingsDto = z.infer<typeof updateSettingsSchema>;
