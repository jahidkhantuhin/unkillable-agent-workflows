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
import type { RunService } from './services/runs';
import { runsRoutes } from './routes/runs';
import { deadLetterRoutes } from './routes/dead-letters';
import { DeadLetterService } from './services/dead-letters';
import { ApprovalService } from './services/approvals';
import { approvalRoutes } from './routes/approvals';
import { ticketRoutes } from './routes/tickets';
import { chaosRoutes } from './routes/chaos';
import type { ChaosService } from './services/chaos';
export function createApp(
  deps: HealthDependencies,
  origins = ['http://localhost:3000'],
  level = 'info',
  authService?: AuthService,
  runService?: RunService,
  chaosService?: ChaosService,
) {
  const app = express();
  app.disable('x-powered-by');
  app.use(
    pinoHttp({
      level,
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      customLogLevel: (req, res, error) =>
        error || res.statusCode >= 500
          ? 'error'
          : res.statusCode >= 400
            ? 'warn'
            : req.method === 'GET'
              ? 'debug'
              : 'info',
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
  if (authService && runService) {
    if (chaosService)
      app.use('/chaos', chaosRoutes(chaosService, authService, origins));
    app.use('/tickets', ticketRoutes(runService, authService, origins));
    app.use(
      '/approvals',
      approvalRoutes(
        new ApprovalService(runService.repository.approvals(), runService),
        authService,
        origins,
      ),
    );
    app.use('/runs', runsRoutes(runService, authService, origins));
    app.use(
      '/dead-letters',
      deadLetterRoutes(
        new DeadLetterService(runService.repository.reliability(), runService),
        authService,
        origins,
      ),
    );
  }
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
