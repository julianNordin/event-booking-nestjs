import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

import { ProblemDetailDto } from '../dto/problem-detail.dto';
import { DomainError } from '../errors/domain-error';
import { mapPrismaError } from './prisma-error.mapper';

const TYPE_PREFIX = 'urn:problem-type:event-booking';

const STATUS_TYPES: Record<number, { type: string; title: string }> = {
  400: { type: `${TYPE_PREFIX}:bad-request`, title: 'The request could not be understood' },
  401: { type: `${TYPE_PREFIX}:unauthorized`, title: 'Authentication is required' },
  403: { type: `${TYPE_PREFIX}:forbidden`, title: 'That is not permitted' },
  404: { type: `${TYPE_PREFIX}:resource-not-found`, title: 'Resource not found' },
  405: { type: `${TYPE_PREFIX}:method-not-allowed`, title: 'That method is not allowed here' },
  409: { type: `${TYPE_PREFIX}:conflict`, title: 'The request conflicts with the current state' },
  415: { type: `${TYPE_PREFIX}:unsupported-media-type`, title: 'That media type is not supported' },
  429: { type: `${TYPE_PREFIX}:too-many-requests`, title: 'Too many requests' },
  500: { type: `${TYPE_PREFIX}:internal-error`, title: 'The server failed to handle the request' },
};

/**
 * One shape for every failure this API produces.
 *
 * Registered over HttpAdapterHost rather than by taking the Express response
 * directly, so the filter works through whatever adapter the app is running on
 * and stays testable without one.
 *
 * @Catch() with no arguments is deliberate: an uncaught error that escapes as
 * Nest's default HTML or JSON is a hole in the contract, and clients that parse
 * problem+json would have to special-case it.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const context = host.switchToHttp();
    const request: unknown = context.getRequest();
    const response: unknown = context.getResponse();

    const problem = this.toProblem(exception, httpAdapter.getRequestUrl(request) as string);

    if (problem.status >= 500) {
      // The only place the original is recorded. It goes to the log, where an
      // operator can see it, and never into the response.
      this.logger.error(
        `unhandled failure on ${problem.instance ?? 'unknown route'}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    httpAdapter.setHeader(response, 'Content-Type', 'application/problem+json');
    httpAdapter.reply(response, problem, problem.status);
  }

  private toProblem(exception: unknown, instance: string): ProblemDetailDto {
    if (exception instanceof DomainError) {
      return {
        type: exception.problemType,
        title: exception.title,
        status: exception.status,
        detail: exception.message,
        instance,
        ...exception.extensions(),
      };
    }

    // A driver error that reached here means a rule the database enforces was
    // broken by a path the service did not check. It is still a client-facing
    // failure with a meaning, so it is translated rather than swallowed as 500.
    const mapped = mapPrismaError(exception);
    if (mapped !== undefined) {
      return {
        type: mapped.problemType,
        title: mapped.title,
        status: mapped.status,
        detail: mapped.message,
        instance,
        ...mapped.extensions(),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const { type, title } = STATUS_TYPES[status] ?? {
        type: `${TYPE_PREFIX}:http-error`,
        title: 'The request failed',
      };

      return { type, title, status, detail: detailOf(exception), instance };
    }

    // Anything else is a bug in this service. The client is told that and
    // nothing more: a stack trace or an ORM message in a 500 body is free
    // reconnaissance and helps nobody who is not attacking it.
    const { type, title } = STATUS_TYPES[500] ?? {
      type: `${TYPE_PREFIX}:internal-error`,
      title: '',
    };
    return {
      type,
      title,
      status: 500,
      detail: 'The server encountered an unexpected condition.',
      instance,
    };
  }
}

/**
 * Nest packs an HttpException's payload into either a string or an object with
 * a `message` that may itself be an array. All three shapes reduce to one
 * sentence here.
 */
function detailOf(exception: HttpException): string {
  const response = exception.getResponse();

  if (typeof response === 'string') {
    return response;
  }

  const message = (response as { message?: unknown }).message;

  if (typeof message === 'string') {
    return message;
  }

  if (Array.isArray(message)) {
    return message.map((entry) => String(entry)).join('; ');
  }

  return exception.message;
}
