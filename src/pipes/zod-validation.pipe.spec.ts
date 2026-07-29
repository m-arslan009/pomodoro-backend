import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProblemException } from '../common/errors/problem.exception';
import { loginSchema } from '../dto/auth.dto';
import { ZodValidationPipe } from './zod-validation.pipe';

/*
 * The pipe that turns a schema failure into the 422 the sign-up form renders.
 *
 * The shape it produces is a contract with the client, not an implementation detail: the
 * frontend's toApiError() reads `errors[].field` and `errors[].message` straight into the state
 * that places a message under an input. A field name that does not match the form control, or a
 * second message for a field that already has one, lands somewhere the user cannot see it.
 *
 * The schemas are exercised in their own spec; the fixtures here are deliberately tiny, so what
 * fails is the pipe's own behaviour rather than a rule borrowed from elsewhere.
 */

function problemFrom(schema: z.ZodType, value: unknown): ProblemException {
  const pipe = new ZodValidationPipe(schema);
  try {
    pipe.transform(value);
  } catch (error) {
    return error as ProblemException;
  }
  throw new Error('expected the pipe to reject this value');
}

describe('ZodValidationPipe', () => {
  it('returns the parsed value, not the raw one', () => {
    const pipe = new ZodValidationPipe(loginSchema);

    // The pipe is the normalisation boundary as well as the validation one: everything
    // downstream is entitled to assume it received the canonical form.
    expect(
      pipe.transform({ identifier: '  ada@evergrove.app  ', password: 'a passphrase' }),
    ).toEqual({ identifier: 'ada@evergrove.app', password: 'a passphrase' });
  });

  it('rejects with a 422 problem carrying one entry per field', () => {
    const problem = problemFrom(loginSchema, { identifier: '', password: '' });

    expect(problem).toBeInstanceOf(ProblemException);
    expect(problem.problem.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(problem.problem.title).toBe('Validation failed');
    expect(problem.problem.errors).toEqual([
      { field: 'identifier', message: 'Enter your email or username.' },
      { field: 'password', message: 'Enter your password.' },
    ]);
  });

  it('keeps only the first message when one field fails twice', () => {
    // Two issues on one path, stated explicitly rather than provoked through a real schema, so
    // the collapsing is what is under test rather than the order Zod happens to emit checks in.
    const schema = z.object({ name: z.string() }).superRefine((_value, ctx) => {
      ctx.addIssue({ code: 'custom', path: ['name'], message: 'first' });
      ctx.addIssue({ code: 'custom', path: ['name'], message: 'second' });
    });

    const problem = problemFrom(schema, { name: 'anything' });

    // A form renders one error under an input; a second would be noise at best and invisible at
    // worst, and the frontend's fieldErrors map keeps the first anyway.
    expect(problem.problem.errors).toEqual([{ field: 'name', message: 'first' }]);
  });

  it('joins a nested path into a single field name', () => {
    const schema = z.object({ profile: z.object({ handle: z.string().min(3, 'Too short.') }) });

    const problem = problemFrom(schema, { profile: { handle: 'ab' } });

    expect(problem.problem.errors).toEqual([{ field: 'profile.handle', message: 'Too short.' }]);
  });

  it('names a whole-body failure "body" rather than an empty string', () => {
    // Reachable only below the HTTP layer — express's strict JSON parser answers 400 for a
    // non-object body before the pipe ever sees it — but a nameless field error would be
    // rendered against no control at all, so the fallback is asserted here.
    const problem = problemFrom(z.string(), 42);

    expect(problem.problem.errors).toHaveLength(1);
    expect(problem.problem.errors?.[0]?.field).toBe('body');
  });
});
