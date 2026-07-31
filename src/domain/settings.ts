/*
 * Preference rules — pure, framework-free, ORM-free (enforced by eslint on src/domain).
 *
 * Constants and defaults only, deliberately: ADR-005 classifies settings as thin CRUD, so a
 * domain *layer* here would be an empty ritual. This module exists so the DTO sources its limits
 * from one place — exactly as auth.dto.ts sources USERNAME_MIN_LENGTH from domain/identifier.ts —
 * and so the frontend has one named authority to mirror in services/validation.js.
 *
 * A client rule looser than these produces a form that passes and then fails at the API; a
 * stricter one blocks input the server would accept. Both are contract violations (CONTRACT.md §3).
 */

export const WORK_MINUTES_MIN = 1;
export const WORK_MINUTES_MAX = 120;
export const BREAK_MINUTES_MIN = 1;
export const BREAK_MINUTES_MAX = 60;

/**
 * Base colour schemes. 'light' is deliberately absent: it set an attribute no stylesheet read, so
 * it claimed a capability the app did not have (CONTRACT.md §9.3). Re-adding it later widens the
 * enum additively — not a breaking change, and not a migration.
 */
export const THEMES = ['system', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/** Shell background presets. Mirrored by BACKGROUND_PRESETS in the frontend's appearance.js. */
export const BACKGROUNDS = ['forest', 'dusk', 'ember', 'midnight'] as const;
export type Background = (typeof BACKGROUNDS)[number];

/** The three forest CSS custom properties the palette editor may override. */
export const THEME_COLOR_KEYS = ['accent', 'leaf', 'wood'] as const;
export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];

/** Six-digit hex, the only form an `<input type="color">` ever produces. */
export const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

/** Timer phase labels are short by design — they render inside the phase indicator. */
export const LABEL_MAX_LENGTH = 18;

export const DEFAULT_WORK_MINUTES = 25;
export const DEFAULT_BREAK_MINUTES = 5;
export const DEFAULT_THEME: Theme = 'system';
export const DEFAULT_BACKGROUND: Background = 'forest';
/** Empty means "use the built-in label", so a blank field is a value rather than a gap. */
export const DEFAULT_LABEL = '';
