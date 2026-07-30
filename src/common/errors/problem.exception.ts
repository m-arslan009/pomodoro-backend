import { HttpException, HttpStatus } from '@nestjs/common';

/*
 * Every deliberate failure in the application is raised as one of these, so the exception
 * filter has a single well-known shape to render and no handler ever formats its own response
 * body (ADR-007: RFC 9457 Problem Details).
 */

export interface FieldError {
  readonly field: string;
  readonly message: string;
}

export interface ProblemDetail {
  readonly status: number;
  readonly title: string;
  readonly detail?: string;
  readonly errors?: readonly FieldError[];
}

export class ProblemException extends HttpException {
  constructor(readonly problem: ProblemDetail) {
    super({ title: problem.title, detail: problem.detail, errors: problem.errors }, problem.status);
  }
}

/**
 * 422 rather than 400: the request was well-formed JSON that failed the rules. It lets the
 * client distinguish "I sent garbage" from "my field values were rejected", which is exactly
 * the distinction the sign-up form needs to place errors on fields.
 */
export function validationProblem(errors: readonly FieldError[]): ProblemException {
  return new ProblemException({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Validation failed',
    detail: 'One or more fields were rejected.',
    errors,
  });
}

/** 409 for a taken email or username. Registration inherently enumerates — accepted, ADR-008. */
export function conflictProblem(errors: readonly FieldError[]): ProblemException {
  return new ProblemException({
    status: HttpStatus.CONFLICT,
    title: 'Account already exists',
    detail: 'An account with those details already exists.',
    errors,
  });
}

/**
 * The single response for every failed login, whatever the cause. A different status, title or
 * field error for "no such user" versus "wrong password" would enumerate accounts as surely as
 * saying so outright.
 */
export function invalidCredentialsProblem(): ProblemException {
  return new ProblemException({
    status: HttpStatus.UNAUTHORIZED,
    title: 'Invalid credentials',
    detail: 'Incorrect email/username or password.',
  });
}

/** The resource exists in the API but not for this account — an avatar nobody has set, say. */
export function notFoundProblem(detail: string): ProblemException {
  return new ProblemException({
    status: HttpStatus.NOT_FOUND,
    title: 'Not found',
    detail,
  });
}

/** No usable access token: absent, malformed, expired or foreign — all indistinguishable. */
export function notAuthenticatedProblem(): ProblemException {
  return new ProblemException({
    status: HttpStatus.UNAUTHORIZED,
    title: 'Not authenticated',
    detail: 'Sign in to continue.',
  });
}
