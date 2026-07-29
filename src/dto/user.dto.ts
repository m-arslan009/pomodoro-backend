import { z } from 'zod';
import {
  NAME_MAX_LENGTH,
  NAME_MIN_LENGTH,
  NAME_PATTERN,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_PATTERN,
} from '../domain/identifier';
import { TIMEZONE_MAX_LENGTH, isValidTimeZone } from '../domain/timezone';

/*
 * Profile updates. Every field is optional — this is a PATCH, and the Profile page saves only
 * what changed.
 *
 * Email is absent by design: it is the account's only recovery channel, so changing it needs a
 * verification round trip rather than a field in this payload. The UI already renders it
 * read-only.
 */

const nameSchema = (label: string) =>
  z
    .string()
    .trim()
    .min(NAME_MIN_LENGTH, `${label} must be at least ${NAME_MIN_LENGTH} characters.`)
    .max(NAME_MAX_LENGTH, `${label} must be ${NAME_MAX_LENGTH} characters or fewer.`)
    .regex(NAME_PATTERN, `${label} cannot contain numbers.`);

export const updateProfileSchema = z
  .object({
    firstName: nameSchema('First name').optional(),
    lastName: nameSchema('Last name').optional(),
    username: z
      .string()
      .trim()
      .min(USERNAME_MIN_LENGTH, `Username must be at least ${USERNAME_MIN_LENGTH} characters.`)
      .max(USERNAME_MAX_LENGTH, `Username must be ${USERNAME_MAX_LENGTH} characters or fewer.`)
      .regex(USERNAME_PATTERN, 'Use only letters, numbers, and underscores.')
      .optional(),
    timezone: z
      .string()
      .trim()
      .max(TIMEZONE_MAX_LENGTH, 'Time zone is too long.')
      .refine(isValidTimeZone, 'Unrecognised time zone.')
      .optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Provide at least one field to update.',
  });

export type UpdateProfileDto = z.infer<typeof updateProfileSchema>;
