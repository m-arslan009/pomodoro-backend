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

/**
 * Refresh-token exchange. Deliberately **not** `CREDENTIAL_THROTTLE`.
 *
 * Brute force is not the threat model: the token is 32 bytes from a CSPRNG, so a tight limit buys
 * nothing that the search space does not already give away for free. Meanwhile the failure mode of
 * being too tight is real and user-visible — a laptop waking with several tabs open, or a handful of
 * reloads, can plausibly cross five in a minute, and a 429 from `/auth/refresh` is not a 401. The
 * client would resolve it to "anonymous" and eject someone who was legitimately signed in.
 *
 * Twenty per minute is hostile to nothing and generous to the real client, which makes about four
 * an hour.
 */
export const REFRESH_THROTTLE = {
  limit: 20,
  ttl: 60_000,
} as const;

/**
 * Avatar uploads. Looser than the credential limit — this is not a guessing attack surface — but
 * far tighter than the global default, because each accepted request writes a quarter-megabyte.
 */
export const AVATAR_THROTTLE = {
  limit: 10,
  ttl: 60_000,
} as const;
