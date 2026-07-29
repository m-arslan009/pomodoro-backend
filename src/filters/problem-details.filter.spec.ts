import { type ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conflictProblem,
  invalidCredentialsProblem,
  notAuthenticatedProblem,
  validationProblem,
} from '../common/errors/problem.exception';
import { ProblemDetailsFilter } from './problem-details.filter';

/*
 * The filter is where a thrown problem becomes bytes, so it is the last place a mistake is
 * cheap. Two things are load-bearing.
 *
 * It is the whole contract with the client. The frontend's toApiError() reads `status`, `title`,
 * `detail` and `errors[]` off this body and branches on them — a wrong status or a dropped
 * `errors` array does not fail here, it fails as a form that cannot show the user what went
 * wrong.
 *
 * And it is the boundary a stack trace must never cross. An unrecognised exception has to lose
 * its message on the way out, because that message is as likely to be a connection string as it
 * is to be useful.
 */

interface Sent {
  status: number;
  contentType: string;
  body: Record<string, unknown>;
}

/** The three chainable members of an express Response that the filter actually calls. */
function fakeResponse(): { response: unknown; sent: Sent } {
  const sent: Sent = { status: 0, contentType: '', body: {} };
  const response = {
    status(code: number) {
      sent.status = code;
      return response;
    },
    type(value: string) {
      sent.contentType = value;
      return response;
    },
    json(payload: Record<string, unknown>) {
      sent.body = payload;
      return response;
    },
  };
  return { response, sent };
}

/*
 * `overrides` replaces the request fields rather than taking an `id` that defaults: passing
 * `undefined` to a defaulted parameter re-applies the default, so "a request with no id" has to
 * be expressed as an object without the key.
 */
function render(exception: unknown, overrides: { id?: string } = { id: 'req-42' }): Sent {
  const { response, sent } = fakeResponse();
  const request = { method: 'POST', url: '/api/v1/auth/login', ...overrides };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;

  new ProblemDetailsFilter().catch(exception, host);
  return sent;
}

beforeEach(() => {
  // The 500 path logs the real error by design. Silenced so a passing run stays readable.
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProblemDetailsFilter', () => {
  it('renders a deliberate problem as RFC 9457, media type included', () => {
    const sent = render(invalidCredentialsProblem());

    expect(sent.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(sent.contentType).toBe('application/problem+json');
    expect(sent.body).toMatchObject({
      type: 'about:blank',
      title: 'Invalid credentials',
      status: 401,
      detail: 'Incorrect email/username or password.',
    });
  });

  it('carries field errors through untouched', () => {
    const errors = [
      { field: 'email', message: 'An account with this email already exists.' },
      { field: 'username', message: 'That username is already taken.' },
    ];

    const sent = render(conflictProblem(errors));

    expect(sent.status).toBe(HttpStatus.CONFLICT);
    // The sign-up form reads exactly this array to place a message under each input.
    expect(sent.body.errors).toEqual(errors);
  });

  it('sends no errors array when the problem has no field detail', () => {
    // A field error on a failed login would name the half that was wrong, which is the
    // distinction the uniform 401 exists to withhold.
    expect(render(invalidCredentialsProblem()).body.errors).toBeUndefined();
    expect(render(notAuthenticatedProblem()).body.errors).toBeUndefined();
  });

  it('reports a validation failure as 422 so it is distinguishable from a rejected credential', () => {
    const sent = render(validationProblem([{ field: 'identifier', message: 'Enter your email.' }]));

    // 401 here would tell the form "your credentials are wrong" when the user simply submitted
    // an empty field, and the two need different messages on screen.
    expect(sent.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(sent.body.title).toBe('Validation failed');
  });

  it('stamps the request id so a reported failure maps to one log line', () => {
    expect(render(notAuthenticatedProblem()).body.instance).toBe('req-42');
  });

  it('omits the instance when the request carries no id', () => {
    expect(render(notAuthenticatedProblem(), {}).body.instance).toBeUndefined();
  });

  it('preserves the status and title of a framework HttpException', () => {
    // Nest raises these itself — an oversized body being the one this API provokes in practice.
    const sent = render(new HttpException('Payload Too Large', HttpStatus.PAYLOAD_TOO_LARGE));

    expect(sent.status).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(sent.body.title).toBe('Payload Too Large');
  });

  it('turns an unrecognised exception into a generic 500 that leaks nothing', () => {
    const leaky = new Error('connect ECONNREFUSED 10.0.0.7:5432 password=hunter2');

    const sent = render(leaky);

    expect(sent.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(sent.body).toMatchObject({
      title: 'Internal server error',
      detail: 'Something went wrong. Please try again.',
    });

    // The point of the test: scan the whole serialised body rather than named fields, so a
    // future change that attaches the cause anywhere at all fails here.
    const wire = JSON.stringify(sent.body);
    expect(wire).not.toContain('ECONNREFUSED');
    expect(wire).not.toContain('hunter2');
    expect(wire).not.toContain('stack');
  });

  it('logs the real error when it answers 500, and stays quiet otherwise', () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    render(new Error('the cause worth keeping'));
    expect(log).toHaveBeenCalledTimes(1);

    log.mockClear();
    render(invalidCredentialsProblem());
    // A wrong password is an expected outcome, not an incident; logging it at error level would
    // bury the failures that matter.
    expect(log).not.toHaveBeenCalled();
  });
});
