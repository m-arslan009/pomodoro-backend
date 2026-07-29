import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { type FieldError, validationProblem } from '../common/errors/problem.exception';

/**
 * The validation boundary (ADR-007). Parsing a body through its schema both validates and
 * normalises it, so everything downstream receives a typed, canonical value.
 *
 * Issues are collapsed to one message per field: a form renders a single error under an input,
 * and reporting three at once would just be noise.
 */
@Injectable()
export class ZodValidationPipe<TOutput> implements PipeTransform<unknown, TOutput> {
  constructor(private readonly schema: ZodType<TOutput>) {}

  transform(value: unknown): TOutput {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    const seen = new Set<string>();
    const errors: FieldError[] = [];
    for (const issue of result.error.issues) {
      const field = issue.path.map(String).join('.') || 'body';
      if (seen.has(field)) continue;
      seen.add(field);
      errors.push({ field, message: issue.message });
    }

    throw validationProblem(errors);
  }
}
