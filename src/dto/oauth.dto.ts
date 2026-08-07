import { z } from 'zod';
import { normalizeReturnTo } from '../domain/oauth';
import { isValidTimeZone } from '../domain/timezone';

/*
 * Request contracts for the two provider-sign-in routes (ADR-008a, CONTRACT.md §4.11, §4.12).
 *
 * These are the only DTOs in the application that **cannot fail**, and the reason is the shape of
 * the routes rather than laxness. Both are browser navigations: a rejected query would be rendered
 * by `ProblemDetailsFilter` as a JSON body, and a JSON body delivered to a top-level navigation is
 * a page of raw JSON in the user's face. So every field is normalised toward a safe value here, and
 * the *flow* decides what a missing or nonsensical one means — which for the callback is a redirect
 * carrying `?oauth_error=invalid_request`, and for start is simply "no destination was requested".
 *
 * Every field is read through `unknown` on purpose. Express parses `?code=a&code=b` into an array
 * and `?code[x]=y` into an object, so a schema of `z.string()` would be describing a type the
 * runtime does not guarantee. Anything that is not a plain string is treated as absent.
 */

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export const oauthStartQuerySchema = z
  .object({
    returnTo: z.unknown().optional(),
    tz: z.unknown().optional(),
  })
  .transform((raw) => ({
    /**
     * Already reduced to an allow-listed path — the caller's own string never survives this — or to
     * `NO_RETURN_TO` when nothing usable was asked for. No default is substituted here: this route
     * runs before anyone has authenticated, so the account whose landing page would be the default
     * is not known yet. The callback fills it in from the profile it ends up with.
     */
    returnTo: normalizeReturnTo(stringOrUndefined(raw.returnTo)),
    /**
     * An unrecognised zone is dropped rather than rejected. It is a convenience the browser
     * volunteered, and refusing a whole sign-in over it would trade a working account with a UTC
     * default for no account at all.
     */
    timezone: (() => {
      const tz = stringOrUndefined(raw.tz);
      return tz !== undefined && isValidTimeZone(tz) ? tz : null;
    })(),
  }));

export const oauthCallbackQuerySchema = z
  .object({
    code: z.unknown().optional(),
    state: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .transform((raw) => ({
    code: stringOrUndefined(raw.code) ?? null,
    state: stringOrUndefined(raw.state) ?? null,
    error: stringOrUndefined(raw.error) ?? null,
  }));

/*
 * `error_description` is deliberately absent from the schema above, not merely unused. It is
 * attacker-influencable text of unknown provenance arriving on an unauthenticated route, and the
 * only safe thing to do with it is to have no variable holding it (§4.12).
 */

export type OAuthStartQuery = z.output<typeof oauthStartQuerySchema>;
export type OAuthCallbackQuery = z.output<typeof oauthCallbackQuerySchema>;
