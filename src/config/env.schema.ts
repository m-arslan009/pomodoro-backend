import { z } from 'zod';

/*
 * Environment contract. Parsed once at boot by ConfigModule's `validate` hook, so a missing or
 * malformed value fails startup with a named error rather than failing request #4000.
 *
 * Token lifetime lives here rather than in code because it is an operational knob: shortening
 * the window during an incident should not require a rebuild.
 */

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required.'),

    /** Comma-separated browser origins allowed to call the API. */
    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),

    BODY_LIMIT: z.string().default('100kb'),

    /*
     * Global request ceiling per IP. The tighter ceiling for credential endpoints is NOT here:
     * it lives in src/common/constants/auth.constants.ts, because a brute-force control that an
     * environment variable can widen is not a control.
     */
    THROTTLE_TTL_MS: z.coerce.number().int().positive().default(900_000),
    THROTTLE_LIMIT: z.coerce.number().int().positive().default(300),

    /*
     * Access-token signing. Unlike every other variable here, JWT_SECRET has no default and never
     * will: a fallback signing key is a key that ships to production, and anyone holding it can
     * mint a token for any user id. Booting without it must fail loudly.
     */
    JWT_SECRET: z
      .string()
      .min(32, 'JWT_SECRET must be at least 32 characters. Generate one: openssl rand -base64 48'),
    /*
     * Lifetime of a signed access token, and the only thing standing between a stolen access token
     * and its holder. `JwtGuard` reads no session row (ADR-008 rev. 3), so this token is valid for
     * exactly this long no matter what happens to the session behind it — revoking a session stops it
     * being *renewed*, not being *used*.
     *
     * That is why this is short rather than a working day: the refresh cookie means the user is not
     * interrupted by a short window, so the only thing a longer one buys is a longer compromise.
     */
    JWT_ACCESS_TTL_MS: z.coerce.number().int().positive().default(900_000),
    JWT_ISSUER: z.string().min(1).default('evergrove'),
    JWT_AUDIENCE: z.string().min(1).default('evergrove-web'),

    /*
     * Refresh sessions (ADR-008 rev. 3). The idle window is how long an unused session survives; the
     * absolute window is the hard cap on a login chain no matter how often it is refreshed, and every
     * rotated successor inherits it.
     *
     * The cookie's Path, its Secure flag and the refresh throttle are deliberately NOT here — they are
     * security policy rather than operational knobs, and live in src/common/utils/cookies.ts and
     * src/common/constants/auth.constants.ts for the same reason CREDENTIAL_THROTTLE does. Secure has
     * a second reason: `z.coerce.boolean()` makes the string "false" evaluate to *true*, so a
     * COOKIE_SECURE=false in a .env would silently enable it.
     */
    SESSION_COOKIE_NAME: z.string().min(1).default('evergrove_session'),
    SESSION_IDLE_TTL_MS: z.coerce.number().int().positive().default(604_800_000),
    SESSION_ABSOLUTE_TTL_MS: z.coerce.number().int().positive().default(2_592_000_000),

    /*
     * Google sign-in (ADR-008a). Off unless switched on, so a deployment that has not registered an
     * OAuth client serves `{"providers": []}` and the sign-in button never appears — rather than
     * shipping a control that 404s.
     *
     * Compared as a string rather than through `z.coerce.boolean()`, which maps the string "false"
     * to *true* and would turn `OAUTH_ENABLED=false` into an enabled feature. The same trap is
     * already documented above for the cookie's Secure flag.
     */
    OAUTH_ENABLED: z
      .string()
      .default('false')
      .transform((value) => value.trim().toLowerCase() === 'true'),

    /*
     * The browser-facing origin of the app — the Vite dev server locally, the Netlify site in
     * production. It builds two things that must agree with each other and with the Google Cloud
     * Console: the `redirect_uri` sent in the authorization request, and the absolute URL the
     * callback finally redirects the browser to.
     *
     * Never derived from the request. A `Host` header is attacker-controlled, and deriving a
     * redirect target from one is how an open redirect gets built by accident.
     */
    APP_ORIGIN: z.string().url('APP_ORIGIN must be an absolute URL.').optional(),

    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),

    /** Lifetime of the signed OAuth transaction cookie, and the window a `state` stays useful. */
    OAUTH_TXN_TTL_MS: z.coerce.number().int().positive().default(600_000),
  })
  /*
   * Two cross-field rules, each encoding a failure that is otherwise silent.
   *
   * An access token outliving the idle window would mean a session that cannot be refreshed still
   * authenticates requests — revocation would appear not to work. A ceiling below the idle window
   * would mean the ceiling is never the binding constraint, so the 30-day cap would be decorative.
   */
  .superRefine((env, ctx) => {
    if (env.JWT_ACCESS_TTL_MS >= env.SESSION_IDLE_TTL_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_ACCESS_TTL_MS'],
        message: 'JWT_ACCESS_TTL_MS must be shorter than SESSION_IDLE_TTL_MS.',
      });
    }

    if (env.SESSION_IDLE_TTL_MS > env.SESSION_ABSOLUTE_TTL_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_IDLE_TTL_MS'],
        message: 'SESSION_IDLE_TTL_MS must not exceed SESSION_ABSOLUTE_TTL_MS.',
      });
    }

    /*
     * Switching Google sign-in on without its three settings would boot cleanly and then fail at
     * the first user who clicked the button — as a 500 on a redirect route, which renders as a
     * blank page. Failing here instead turns it into a startup error naming the missing variable.
     */
    if (!env.OAUTH_ENABLED) return;

    const required = ['APP_ORIGIN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const;
    for (const key of required) {
      if (env[key] === undefined || env[key].trim() === '') {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required when OAUTH_ENABLED is true.`,
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * ConfigModule `validate` hook. Throws with every problem listed at once, so a misconfigured
 * deployment is diagnosed in one restart rather than one variable per restart.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}
