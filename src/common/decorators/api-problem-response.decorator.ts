import { applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';

import { ProblemDetailDto } from '../dto/problem-detail.dto';

/**
 * Declares one failure response as `application/problem+json`.
 *
 * This exists because of a specific and expensive default: an operation that
 * does not declare its error responses is documented by the generator as
 * returning the **success** schema for them. A client generated from that
 * document expects an `Event` back from a 404, and finds out otherwise in
 * production.
 *
 * Wrapping it in one decorator rather than repeating the `content` block keeps
 * the media type in a single place. Every error in this API has the same shape,
 * and the document should say so once.
 */
function problemResponse(status: number, description: string): MethodDecorator {
  return applyDecorators(
    // ProblemDetailDto is referenced by every error and owned by no route, so
    // without this it never reaches components.schemas and every $ref dangles.
    ApiExtraModels(ProblemDetailDto),
    ApiResponse({
      status,
      description,
      content: {
        'application/problem+json': { schema: { $ref: getSchemaPath(ProblemDetailDto) } },
      },
    }),
  );
}

export const ApiProblemBadRequest = (
  description = 'The request failed validation. `errors` names each field.',
): MethodDecorator => problemResponse(400, description);

export const ApiProblemUnauthorized = (
  description = 'No usable `x-api-key` header was presented.',
): MethodDecorator => problemResponse(401, description);

export const ApiProblemNotFound = (description = 'No such resource.'): MethodDecorator =>
  problemResponse(404, description);

export const ApiProblemConflict = (
  description = 'The request conflicts with the current state.',
): MethodDecorator => problemResponse(409, description);

export const ApiProblemServiceUnavailable = (
  description = 'A dependency this service needs is not answering.',
): MethodDecorator => problemResponse(503, description);

export const ApiProblemTooManyRequests = (
  description = 'Rate limit exceeded for this endpoint.',
): MethodDecorator => problemResponse(429, description);
