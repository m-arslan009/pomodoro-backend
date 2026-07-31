/*
 * Plain shapes that cross layer boundaries, and the one place the stored split is undone.
 *
 * The database keeps preferences in two forms — scalar columns and a JSONB blob (CONTRACT.md
 * §1.4) — and the API returns one flat object (§2.2). That translation lives here, so moving a key
 * between column and blob later is not a breaking API change.
 */

import {
  type Background,
  BACKGROUNDS,
  DEFAULT_BACKGROUND,
  DEFAULT_BREAK_MINUTES,
  DEFAULT_LABEL,
  DEFAULT_THEME,
  DEFAULT_WORK_MINUTES,
  type Theme,
  THEME_COLOR_KEYS,
  THEMES,
} from '../../domain/settings';

/** A forest palette override. All three keys are present or the whole object is null. */
export type CustomTheme = Record<(typeof THEME_COLOR_KEYS)[number], string>;

/** Timer phase labels. An empty string means "use the built-in label". */
export interface TimerLabels {
  readonly work: string;
  readonly break: string;
}

/** The stored row as the repository reads it. `preferences` is unvalidated JSONB. */
export interface SettingsRecord {
  readonly workMinutes: number;
  readonly breakMinutes: number;
  readonly theme: string;
  readonly preferences: unknown;
  readonly updatedAt: Date;
}

/** The appearance keys held in the `preferences` blob, as a patch fragment. */
export interface PreferencesPatch {
  readonly customTheme?: CustomTheme | null;
  readonly background?: Background;
  readonly labels?: TimerLabels;
}

/** What the API returns for an account's preferences. A separate payload from UserProfile. */
export interface UserSettings {
  readonly workMinutes: number;
  readonly breakMinutes: number;
  readonly theme: Theme;
  readonly customTheme: CustomTheme | null;
  readonly background: Background;
  readonly labels: TimerLabels;
  readonly updatedAt: string | null;
}

/**
 * What an account that has never saved anything gets. Reading does not create the row, so this is
 * the response for most accounts most of the time.
 */
export const DEFAULT_USER_SETTINGS: UserSettings = {
  workMinutes: DEFAULT_WORK_MINUTES,
  breakMinutes: DEFAULT_BREAK_MINUTES,
  theme: DEFAULT_THEME,
  customTheme: null,
  background: DEFAULT_BACKGROUND,
  labels: { work: DEFAULT_LABEL, break: DEFAULT_LABEL },
  updatedAt: null,
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/*
 * Everything below re-reads the blob defensively.
 *
 * Zod guarantees the shape of what this process writes, but not of what is already at rest: the
 * column predates no schema, and a hand-edited or downgraded row must degrade to a default rather
 * than serve the client a value its own types say is impossible.
 */

function readTheme(value: string): Theme {
  return (THEMES as readonly string[]).includes(value) ? (value as Theme) : DEFAULT_THEME;
}

function readCustomTheme(value: unknown): CustomTheme | null {
  const source = asRecord(value);
  const colors: Record<string, string> = {};
  for (const key of THEME_COLOR_KEYS) {
    const color = source[key];
    if (typeof color !== 'string') return null;
    colors[key] = color;
  }
  return colors as CustomTheme;
}

function readBackground(value: unknown): Background {
  return typeof value === 'string' && (BACKGROUNDS as readonly string[]).includes(value)
    ? (value as Background)
    : DEFAULT_BACKGROUND;
}

function readLabels(value: unknown): TimerLabels {
  const source = asRecord(value);
  return {
    work: typeof source.work === 'string' ? source.work : DEFAULT_LABEL,
    break: typeof source.break === 'string' ? source.break : DEFAULT_LABEL,
  };
}

/** Flatten a stored row into the API shape. A missing row is the defaults, never a 404. */
export function toUserSettings(record: SettingsRecord | null): UserSettings {
  if (!record) return DEFAULT_USER_SETTINGS;

  const preferences = asRecord(record.preferences);
  return {
    workMinutes: record.workMinutes,
    breakMinutes: record.breakMinutes,
    theme: readTheme(record.theme),
    customTheme: readCustomTheme(preferences.customTheme),
    background: readBackground(preferences.background),
    labels: readLabels(preferences.labels),
    updatedAt: record.updatedAt.toISOString(),
  };
}
