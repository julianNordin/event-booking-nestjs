import type { Server } from 'node:http';

import { Body, Controller, Get, INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Type } from 'class-transformer';
import { IsInt, IsString, Min } from 'class-validator';
import request from 'supertest';

import { GLOBAL_PREFIX } from './config/app.config';
import { configureApp } from './configure-app';

class ProbeDto {
  @IsString()
  title!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  capacity!: number;
}

@Controller('probe')
class ProbeController {
  @Get()
  read(): { ok: true } {
    return { ok: true };
  }

  @Post()
  write(@Body() body: ProbeDto): ProbeDto {
    return body;
  }
}

describe('configureApp', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
    }).compile();

    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('the global prefix', () => {
    it('serves routes underneath it', async () => {
      await request(server).get(`/${GLOBAL_PREFIX}/probe`).expect(200, { ok: true });
    });

    it('does not serve them at the bare path', async () => {
      await request(server).get('/probe').expect(404);
    });
  });

  describe('the global validation pipe', () => {
    it('accepts a well formed body', async () => {
      await request(server)
        .post(`/${GLOBAL_PREFIX}/probe`)
        .send({ title: 'Kubernetes at scale', capacity: 40 })
        .expect(201, { title: 'Kubernetes at scale', capacity: 40 });
    });

    it('rejects a body with an unknown property instead of silently dropping it', async () => {
      // forbidNonWhitelisted. A client that misspells a field gets told; without
      // it the value disappears and the caller believes it was applied.
      const response = await request(server)
        .post(`/${GLOBAL_PREFIX}/probe`)
        .send({ title: 'Kubernetes at scale', capacity: 40, capcity: 900 })
        .expect(400);

      expect(JSON.stringify(response.body)).toMatch(/capcity/);
    });

    it('rejects a body that breaks a declared rule', async () => {
      await request(server)
        .post(`/${GLOBAL_PREFIX}/probe`)
        .send({ title: 'Kubernetes at scale', capacity: 0 })
        .expect(400);
    });

    it('transforms declared types rather than passing strings through', async () => {
      const response = await request(server)
        .post(`/${GLOBAL_PREFIX}/probe`)
        .send({ title: 'Kubernetes at scale', capacity: '40' })
        .expect(201);

      expect(response.body).toEqual({ title: 'Kubernetes at scale', capacity: 40 });
    });
  });
});
