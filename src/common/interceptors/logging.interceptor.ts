import { randomUUID } from 'node:crypto';

import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';

/** Where the id is stashed, for the exception filter to find. */
export const REQUEST_ID_KEY = 'requestId';

/** Both read and written, so an id from a proxy or a client survives the hop. */
export const REQUEST_ID_HEADER = 'x-request-id';

interface TracedRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  [REQUEST_ID_KEY]?: string;
}

interface TracedResponse {
  statusCode?: number;
  setHeader?: (name: string, value: string) => void;
}

/**
 * One log line per request, with an id and a duration.
 *
 * This is what interceptors are genuinely for: something that wraps every
 * handler, needs to run before and after it, and would otherwise be copied into
 * each one. A guard cannot do it (it only runs before), and a filter cannot
 * (it only runs on failure).
 *
 * An inbound `x-request-id` is honoured rather than replaced, so a trace begun
 * by a proxy or a client survives this hop. The id is echoed back on the
 * response and stashed on the request, where the exception filter picks it up
 * and puts it in the problem body — which is what lets somebody quote a single
 * string in a support ticket and have it found in the logs.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<TracedRequest>();
    const response = http.getResponse<TracedResponse>();

    const inbound = request.headers[REQUEST_ID_HEADER];
    const requestId = typeof inbound === 'string' && inbound !== '' ? inbound : randomUUID();

    request[REQUEST_ID_KEY] = requestId;
    response.setHeader?.(REQUEST_ID_HEADER, requestId);

    // hrtime rather than Date.now: it is monotonic, so a clock adjustment
    // mid-request cannot produce a negative duration.
    const startedAt = process.hrtime.bigint();

    const finish = (outcome: string): void => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;

      this.logger.log(
        `${request.method ?? '?'} ${request.url ?? '?'} ${outcome} ` +
          `${ms.toFixed(1)}ms [${requestId}]`,
      );
    };

    return next.handle().pipe(
      tap({
        next: () => {
          finish(String(response.statusCode ?? 200));
        },
        // Logged on the way out too, or every failed request is missing from
        // the timing record — which is the half you most want when something
        // is slow.
        error: (error: unknown) => {
          finish(error instanceof Error ? `failed (${error.name})` : 'failed');
        },
      }),
    );
  }
}
