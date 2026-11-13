import { randomUUID } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { healthRoutes } from './routes/health';
import { errorHandler } from './middleware/error';
import type { HealthDependencies } from './services/health';
import type { AuthService } from './services/auth';
import { authRoutes } from './routes/auth';
export function createApp(
  deps: HealthDependencies,
  origins = ['http://localhost:3000'],
  level = 'info',
  authService?: AuthService,
) {
  const app = express();
  app.disable('x-powered-by');
  app.use(
    pinoHttp({
      level,
      redact: [
        'req.headers.cookie',
        'req.headers.authorization',
        'res.headers.set-cookie',
      ],
      genReqId: (_req, res) => {
        const id = randomUUID();
        res.setHeader('X-Request-ID', id);
        return id;
      },
    }),
  );
  app.use(
    helmet(),
    cors({ origin: origins, credentials: true }),
    express.json({ limit: '1mb' }),
  );
  app.use(healthRoutes(deps));
  if (authService) app.use('/auth', authRoutes(authService, origins));
  app.use((req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found',
        requestId: req.id,
      },
    });
  });
  app.use(errorHandler);
  return app;
}
