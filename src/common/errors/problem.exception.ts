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

/**
 * Two records claiming the same instant — a double-tap, or two devices both insisting they ran a
 * block at 09:14:02.
 *
 * Deliberately NOT the response to a repeated `clientSessionId`: that is the outbox retrying, and
 * it resolves to the original record with a 200. Returning 409 there would make a client treat its
 * own successful retry as a failure and, worse, teach it to stop retrying.
 */
export function sessionConflictProblem(detail: string): ProblemException {
  return new ProblemException({
    status: HttpStatus.CONFLICT,
    title: 'Session conflict',
    detail,
  });
}

/**
 * "There is no such route here" — for a namespace that must not admit it exists.
 *
 * DELIBERATELY INDISTINGUISHABLE FROM AN UNMATCHED ROUTE, and that is the entire specification. The
 * admin namespace answers 404 rather than 403 to a non-admin (`admin_role_plan.md` §4.2), so that a
 * curious account learns nothing from probing it: 403 confirms the endpoint is real and that someone
 * has access to it, which is exactly the map an attacker is drawing.
 *
 * The rendered body must therefore match, byte for byte, what an unmatched URL produces. Nest's own
 * `NotFoundException` reaches `ProblemDetailsFilter`'s generic `HttpException` branch, which reads
 * `error` for the title and sets no `detail` — hence the capitalised `'Not Found'` (not this file's
 * usual `'Not found'`) and hence the absence of a detail string, which would otherwise be the tell
 * that distinguishes a guarded route from a nonexistent one.
 *
 * Never use this for a resource that is genuinely missing but whose route is public — that is
 * `notFoundProblem`, which says something useful because it safely can.
 */
export function routeNotFoundProblem(): ProblemException {
  return new ProblemException({
    status: HttpStatus.NOT_FOUND,
    title: 'Not Found',
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
