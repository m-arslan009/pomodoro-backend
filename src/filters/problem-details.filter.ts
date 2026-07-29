import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ProblemException, type FieldError } from '../common/errors/problem.exception';

interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  errors?: readonly FieldError[];
}

/**
 * Renders every failure as RFC 9457 Problem Details (ADR-007).
 *
 * Two guarantees matter here. A stack trace never reaches a client — an unrecognised exception
 * becomes a generic 500 and the real error goes to the log. And `instance` carries the request
 * id, so a user reporting "it failed" maps to exactly one log line (ADR-016).
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request & { id?: string }>();

    const body = this.toProblem(exception);
    body.instance = typeof request.id === 'string' ? request.id : undefined;

    // Compared as a plain number: `body.status` is a number, not an HttpStatus member.
    if (body.status >= 500) {
      this.logger.error(
        `Unhandled failure on ${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(body.status).type('application/problem+json').json(body);
  }

  private toProblem(exception: unknown): ProblemBody {
    if (exception instanceof ProblemException) {
      const { status, title, detail, errors } = exception.problem;
      return { type: 'about:blank', title, status, detail, errors };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const title =
        typeof payload === 'string'
          ? payload
          : ((payload as { error?: string }).error ?? exception.message);
      return { type: 'about:blank', title, status };
    }

    return {
      type: 'about:blank',
      title: 'Internal server error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: 'Something went wrong. Please try again.',
    };
  }
}
