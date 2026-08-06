import { z } from 'zod';
import { FREQUENCY_CHOICES } from '../domain/report';

/*
 * Report subscription requests.
 *
 * Every rule is imported from src/domain rather than restated, so the API boundary and the business
 * rules cannot drift apart — the same discipline settings.dto.ts follows.
 */

/**
 * The three answers, and only these three (CONTRACT.md §25.2).
 *
 * `strictObject` rejects unknown keys rather than dropping them silently. A client sending
 * `{ enabled: true }` should be told it sent nothing this endpoint understands, not have its
 * request accepted and ignored — which is how a UI ends up showing a preference the server never
 * stored.
 */
export const updateReportSubscriptionSchema = z.strictObject({
  frequency: z.enum(FREQUENCY_CHOICES, 'Choose weekly, monthly, or none.'),
});

/**
 * A link credential. Deliberately loose on shape and strict on size.
 *
 * There is no format check beyond a length bound, because a malformed token and an unknown one must
 * be indistinguishable: a 422 for "that is not base64url" and a 200 `invalid` for "no such token"
 * would let anyone with a URL sort real tokens from noise. Everything is answered by the service,
 * identically. The bound is here only so a megabyte of string never reaches a hash function.
 */
const tokenSchema = z
  .string()
  .trim()
  .min(1, 'This link is missing its token.')
  .max(256, 'This link is not valid.');

export const reportTokenSchema = z.strictObject({ token: tokenSchema });

export type UpdateReportSubscriptionDto = z.infer<typeof updateReportSubscriptionSchema>;
export type ReportTokenDto = z.infer<typeof reportTokenSchema>;
