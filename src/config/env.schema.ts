import { z } from 'zod';

/*
 * Environment contract. Parsed once at boot by ConfigModule's `validate` hook, so a missing or
 * malformed value fails startup with a named error rather than failing request #4000.
 *
 * Token lifetime lives here rather than in code because it is an operational knob: shortening
 * the window during an incident should not require a rebuild.
 */

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

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
   * Lifetime of a signed access token, and the only thing standing between a stolen token and
   * its holder — there is no refresh, no session table and no revocation, so a token is valid
   * for exactly this long no matter what happens to the account in the meantime.
   *
   * 8 hours covers a working day, which is the point: the user signs in once and is not
   * interrupted. Shorten it in an incident; lengthening it lengthens the compromise window by
   * the same amount.
   */
  JWT_ACCESS_TTL_MS: z.coerce.number().int().positive().default(28_800_000),
  JWT_ISSUER: z.string().min(1).default('evergrove'),
  JWT_AUDIENCE: z.string().min(1).default('evergrove-web'),
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
