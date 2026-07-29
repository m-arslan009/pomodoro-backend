import { z } from 'zod';
import {
  EMAIL_MAX_LENGTH,
  EMAIL_PATTERN,
  NAME_MAX_LENGTH,
  NAME_MIN_LENGTH,
  NAME_PATTERN,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_PATTERN,
} from '../domain/identifier';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_VIOLATION_MESSAGES,
} from '../domain/password-policy';
import { TIMEZONE_MAX_LENGTH, isValidTimeZone } from '../domain/timezone';

/*
 * Request contracts. Every rule here is imported from src/domain rather than restated, so the
 * API boundary and the business rules cannot drift apart — and the same constants are mirrored
 * in the frontend's services/validation.js.
 *
 * Normalisation happens here, at the boundary (ADR-003): emails arrive trimmed and lowercased,
 * usernames arrive trimmed with their casing intact.
 */

const nameSchema = (label: string) =>
  z
    .string()
    .trim()
    .min(NAME_MIN_LENGTH, `${label} must be at least ${NAME_MIN_LENGTH} characters.`)
    .max(NAME_MAX_LENGTH, `${label} must be ${NAME_MAX_LENGTH} characters or fewer.`)
    .regex(NAME_PATTERN, `${label} cannot contain numbers.`);

const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, PASSWORD_VIOLATION_MESSAGES.too_short)
  .max(PASSWORD_MAX_LENGTH, PASSWORD_VIOLATION_MESSAGES.too_long);

export const registerSchema = z.object({
  firstName: nameSchema('First name'),
  lastName: nameSchema('Last name'),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(EMAIL_MAX_LENGTH, 'Email is too long.')
    .regex(EMAIL_PATTERN, 'Enter a valid email address.'),
  username: z
    .string()
    .trim()
    .min(USERNAME_MIN_LENGTH, `Username must be at least ${USERNAME_MIN_LENGTH} characters.`)
    .max(USERNAME_MAX_LENGTH, `Username must be ${USERNAME_MAX_LENGTH} characters or fewer.`)
    .regex(USERNAME_PATTERN, 'Use only letters, numbers, and underscores.'),
  password: passwordSchema,
  /*
   * Sent by the browser from Intl.DateTimeFormat().resolvedOptions().timeZone. Optional so a
   * client that cannot determine it still registers; the column then falls back to UTC.
   */
  timezone: z
    .string()
    .trim()
    .max(TIMEZONE_MAX_LENGTH, 'Time zone is too long.')
    .refine(isValidTimeZone, 'Unrecognised time zone.')
    .optional(),
});

/*
 * Login validates almost nothing on purpose.
 *
 * Rejecting a malformed email here would answer "is this shape even registrable?" before the
 * credential check — a response that varies by cause, which is the enumeration channel the
 * approved design closes. A wrong identifier must fail exactly like a wrong password. The only
 * limits are presence and an upper bound, which exist to stop an oversized body reaching Argon2.
 */
export const loginSchema = z.object({
  identifier: z
    .string()
    .trim()
    .min(1, 'Enter your email or username.')
    .max(EMAIL_MAX_LENGTH, 'That identifier is too long.'),
  password: z
    .string()
    .min(1, 'Enter your password.')
    .max(PASSWORD_MAX_LENGTH, 'Password is too long.'),
});

export const changePasswordSchema = z.object({
  currentPassword: z
    .string()
    .min(1, 'Enter your current password.')
    .max(PASSWORD_MAX_LENGTH, 'Password is too long.'),
  newPassword: passwordSchema,
});

export type RegisterDto = z.infer<typeof registerSchema>;
export type LoginDto = z.infer<typeof loginSchema>;
export type ChangePasswordDto = z.infer<typeof changePasswordSchema>;
