import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

import { ProblemDetailDto } from './common/dto/problem-detail.dto';
import { API_KEY_HEADER } from './config/security.config';

/** The security scheme name referenced by `@ApiSecurity()` on protected routes. */
export const ORGANISER_KEY_SCHEME = 'organiser-key';

export const DOCS_PATH = 'docs';
export const DOCS_JSON_PATH = 'docs-json';

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('event-booking-api')
    .setDescription(
      'Events, attendees and registrations. Capacity is enforced with a row lock, so an ' +
        'event cannot overbook however many people arrive at once. Errors are RFC 9457 ' +
        'problem details served as application/problem+json.',
    )
    .setVersion('1.0')
    .addApiKey(
      {
        type: 'apiKey',
        name: API_KEY_HEADER,
        in: 'header',
        description:
          'Identifies the organiser. Required for creating and managing events and for ' +
          'reading an event roster. Browsing events and registering are public.',
      },
      ORGANISER_KEY_SCHEME,
    )
    .build();

  return SwaggerModule.createDocument(app, config, {
    // Referenced by every error response but owned by no route, so it would
    // otherwise never make it into components.schemas.
    extraModels: [ProblemDetailDto],
  });
}

/**
 * Serves the UI at /docs and the raw document at /docs-json.
 *
 * Both sit outside the /api/v1 prefix: they describe the API rather than being
 * part of it, and versioning the documentation alongside the routes it
 * documents makes the URL change every time the API does.
 *
 * Nest bundles swagger-ui's assets and serves them from this application, so
 * the page loads nothing from a CDN. That is worth stating because the
 * alternative — the hosted swagger-ui build — breaks on any deployment without
 * outbound internet, which is most of them, and only in production.
 */
export function setupOpenApi(app: INestApplication): void {
  SwaggerModule.setup(DOCS_PATH, app, buildOpenApiDocument(app), {
    jsonDocumentUrl: DOCS_JSON_PATH,
    swaggerOptions: {
      // Keeps the expanded/collapsed state and the chosen scheme across
      // reloads, which is the difference between the page being usable and
      // being re-navigated every time.
      persistAuthorization: true,
    },
  });
}
