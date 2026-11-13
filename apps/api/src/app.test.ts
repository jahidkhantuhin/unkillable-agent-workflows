import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import { createApp } from './app';
import { validate } from './middleware/validate';
import { errorHandler } from './middleware/error';
import { configSchema } from './config';
const good = async () => 'ok';
describe('API foundation', () => {
  it('reports both dependencies and security headers', async () => {
    const res = await request(
      createApp({ mongo: good, redis: good }, undefined, 'silent'),
    )
      .get('/health')
      .set('Origin', 'http://localhost:3000');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      services: { mongo: true, redis: true },
    });
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['access-control-allow-origin']).toBe(
      'http://localhost:3000',
    );
  });
  it.each(['mongo', 'redis'] as const)(
    'returns 503 when %s is down',
    async (dependency) => {
      const app = createApp(
        {
          mongo: good,
          redis: good,
          [dependency]: async () => {
            throw new Error('offline');
          },
        },
        undefined,
        'silent',
      );
      const res = await request(app).get('/health');
      expect(res.status).toBe(503);
      expect(res.body.services[dependency]).toBe(false);
    },
  );
  it('does not allow an unknown CORS origin', async () => {
    const res = await request(
      createApp({ mongo: good, redis: good }, undefined, 'silent'),
    )
      .get('/health')
      .set('Origin', 'https://unknown.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('validates requests and catches async errors without leaking internals', async () => {
    const { default: express } = await import('express');
    const testApp = express();
    testApp.use((await import('pino-http')).pinoHttp({ level: 'silent' }));
    testApp.use(express.json());
    testApp.post(
      '/validate',
      validate(z.object({ name: z.string() })),
      (_req, res) => {
        res.json(res.locals.body);
      },
    );
    testApp.get('/fail', async () => {
      throw new Error('secret');
    });
    testApp.use(errorHandler);
    expect((await request(testApp).post('/validate').send({})).status).toBe(
      400,
    );
    expect(
      (await request(testApp).post('/validate').send({ name: 'test' })).body,
    ).toEqual({ name: 'test' });
    const failure = await request(testApp).get('/fail');
    expect(failure.status).toBe(500);
    expect(JSON.stringify(failure.body)).not.toContain('secret');
  });
  it('fails fast for invalid config', () => {
    expect(configSchema.safeParse({ API_PORT: -1 }).success).toBe(false);
  });
});
