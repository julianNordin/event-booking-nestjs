import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import request from 'supertest';

import { GLOBAL_PREFIX } from '../../src/config/app.config';
import { buildOpenApiDocument, DOCS_JSON_PATH, DOCS_PATH } from '../../src/openapi';
import { createTestApp } from '../support/app';

interface Operation {
  responses?: Record<
    string,
    { content?: Record<string, unknown>; description?: string; schema?: unknown }
  >;
  security?: unknown[];
  parameters?: { name: string; in: string }[];
  requestBody?: unknown;
}

const METHODS = ['get', 'post', 'patch', 'put', 'delete'] as const;

/**
 * Keeps the published document honest as the API grows.
 *
 * The document is generated from the same application the end-to-end tier
 * drives, so a route added without documentation shows up here rather than in
 * somebody's integration attempt. These are assertions about *every* operation,
 * deliberately — a test that names each route by hand is a second list to
 * forget to update.
 */
describe('the OpenAPI document', () => {
  let app: INestApplication;
  let server: Server;
  let document: OpenAPIObject;

  beforeAll(async () => {
    ({ app, server } = await createTestApp());
    document = buildOpenApiDocument(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const operations = (): { route: string; method: string; operation: Operation }[] =>
    Object.entries(document.paths).flatMap(([route, item]) =>
      METHODS.filter((method) => method in item).map((method) => ({
        route,
        method,
        operation: (item as Record<string, Operation>)[method]!,
      })),
    );

  it('documents every route the application serves', () => {
    const routes = Object.keys(document.paths);

    expect(routes.length).toBeGreaterThan(10);

    // Everything except /health, which is deliberately outside the versioned
    // prefix: it reports on the process rather than on the API.
    const versioned = routes.filter((route) => route !== '/health');
    for (const route of versioned) {
      expect(route.startsWith(`/${GLOBAL_PREFIX}/`)).toBe(true);
    }
  });

  it('covers each resource the API exposes', () => {
    const routes = Object.keys(document.paths).join(' ');

    expect(routes).toContain('/events');
    expect(routes).toContain('/events/{id}');
    expect(routes).toContain('/attendees');
    expect(routes).toContain('/registrations/{id}');
    expect(routes).toContain('/waitlist');
  });

  describe('every operation', () => {
    it('declares at least one response', () => {
      const silent = operations()
        .filter(({ operation }) => Object.keys(operation.responses ?? {}).length === 0)
        .map(({ route, method }) => `${method.toUpperCase()} ${route}`);

      expect(silent).toEqual([]);
    });

    it('declares every error response as application/problem+json', () => {
      // Left undeclared, the generator documents a 404 with the operation's
      // *success* schema — so a client generated from this document expects an
      // Event back from a failure. This is the assertion that stops that.
      const offenders: string[] = [];

      for (const { route, method, operation } of operations()) {
        for (const [status, response] of Object.entries(operation.responses ?? {})) {
          if (Number(status) < 400) {
            continue;
          }

          const media = Object.keys(response.content ?? {});

          if (!media.includes('application/problem+json')) {
            offenders.push(`${method.toUpperCase()} ${route} -> ${status} (${media.join(', ')})`);
          }
        }
      }

      expect(offenders).toEqual([]);
    });

    it('gives every declared response a description', () => {
      const undescribed = operations().flatMap(({ route, method, operation }) =>
        Object.entries(operation.responses ?? {})
          .filter(([, response]) => (response.description ?? '') === '')
          .map(([status]) => `${method.toUpperCase()} ${route} -> ${status}`),
      );

      expect(undescribed).toEqual([]);
    });

    it('declares a path parameter for every placeholder in its route', () => {
      const missing: string[] = [];

      for (const { route, method, operation } of operations()) {
        const placeholders = [...route.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
        const declared = (operation.parameters ?? [])
          .filter((parameter) => parameter.in === 'path')
          .map((parameter) => parameter.name);

        for (const placeholder of placeholders) {
          if (placeholder !== undefined && !declared.includes(placeholder)) {
            missing.push(`${method.toUpperCase()} ${route} -> ${placeholder}`);
          }
        }
      }

      expect(missing).toEqual([]);
    });
  });

  describe('the health operation', () => {
    // Settled by measurement rather than by reading decorators: with the
    // container stopped, /health answers 503 with a problem+json body, because
    // the global filter converts Terminus's ServiceUnavailableException like
    // any other. Terminus's own @HealthCheck() declared that response as
    // application/json instead, and won whichever order the decorators were
    // written in — @nestjs/swagger merges two declarations of one status into
    // a single entry, and a `schema` beats a `content` block. So its
    // documentation is turned off and both responses are declared here.
    const health = (): Operation => document.paths['/health']?.get as Operation;

    it('declares its 503 as problem+json, matching what the wire returns', () => {
      const media = Object.keys(health().responses?.['503']?.content ?? {});

      expect(media).toEqual(['application/problem+json']);
    });

    it('declares a 200 with the real health-check shape, not an empty object', () => {
      const ok = health().responses?.['200'];
      const schema = (ok?.content?.['application/json'] as { schema?: { $ref?: string } })?.schema;

      expect(schema?.$ref).toBe('#/components/schemas/HealthResponseDto');
    });

    it('describes the health-check body with its real fields', () => {
      const dto = document.components?.schemas?.HealthResponseDto as
        { properties?: Record<string, unknown> } | undefined;

      expect(Object.keys(dto?.properties ?? {})).toEqual(
        expect.arrayContaining(['status', 'info', 'error', 'details']),
      );
    });

    it('needs no API key', () => {
      // An orchestrator cannot be handed an organiser's key, and the document
      // is where a client finds that out before trying.
      expect(health().security ?? []).toEqual([]);
    });
  });

  describe('the schemas', () => {
    it('include the problem detail shape every error refers to', () => {
      expect(document.components?.schemas).toHaveProperty('ProblemDetailDto');
    });

    it('describe the event response with its real fields, not an empty object', () => {
      // The check that the Swagger plugin actually ran under this compiler. It
      // does not run through ts-jest by default, and without it every schema
      // here would be an empty object while production served a complete one.
      const event = document.components?.schemas?.EventResponseDto as
        { properties?: Record<string, unknown> } | undefined;

      expect(Object.keys(event?.properties ?? {})).toEqual(
        expect.arrayContaining([
          'id',
          'title',
          'venue',
          'startsAt',
          'endsAt',
          'capacity',
          'status',
          'confirmedCount',
          'waitlistCount',
          'availableSeats',
        ]),
      );
    });
  });

  describe('security', () => {
    it('declares the organiser API key scheme', () => {
      const scheme = document.components?.securitySchemes?.['organiser-key'];

      expect(scheme).toMatchObject({ type: 'apiKey', in: 'header', name: 'x-api-key' });
    });

    it('marks the organiser-only operations as requiring it', () => {
      const write = document.paths['/api/v1/events']?.post as Operation | undefined;

      expect(write?.security).toBeDefined();
    });

    it('leaves the public operations unsecured', () => {
      const browse = document.paths['/api/v1/events']?.get as Operation | undefined;

      expect(browse?.security ?? []).toEqual([]);
    });
  });

  describe('what is served', () => {
    it('publishes the document at /docs-json', async () => {
      const response = await request(server).get(`/${DOCS_JSON_PATH}`).expect(200);

      expect((response.body as OpenAPIObject).openapi).toMatch(/^3\./);
      expect((response.body as OpenAPIObject).info.title).toBe('event-booking-api');
    });

    it('serves the UI at /docs', async () => {
      const response = await request(server).get(`/${DOCS_PATH}`).expect(200);

      expect(response.text).toMatch(/swagger/i);
    });

    it('loads no assets from a CDN', async () => {
      // A hosted swagger-ui build breaks on any deployment without outbound
      // internet, which is most of them, and only in production.
      const response = await request(server).get(`/${DOCS_PATH}`).expect(200);

      const absolute = [...response.text.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(
        (match) => match[1],
      );

      expect(absolute).toEqual([]);
    });

    it('sits outside the versioned API prefix', async () => {
      // The documentation describes the API rather than being part of it.
      await request(server).get(`/${GLOBAL_PREFIX}/${DOCS_JSON_PATH}`).expect(404);
    });
  });
});
