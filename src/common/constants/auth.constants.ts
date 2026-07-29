/*
 * Credential-endpoint throttling.
 *
 * Deliberately constants rather than environment variables: this is the brute-force control,
 * and a security policy that can be widened by an environment variable is a security policy
 * that will be widened by an environment variable. Changing it should require a reviewed commit.
 *
 * Five attempts per minute per IP is generous for a human and hostile to a script. Account
 * lockout is intentionally NOT implemented — it turns a known username into a denial-of-service
 * against its owner (see the approved User-model analysis).
 */
export const CREDENTIAL_THROTTLE = {
  limit: 5,
  ttl: 60_000,
} as const;
