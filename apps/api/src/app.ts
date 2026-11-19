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
import { PolicyService } from './services/policies';
import { policyRoutes, analyticsRoutes } from './routes/policies';
import { moderationRoutes } from './routes/moderation';
import { ModerationService } from './services/moderation';
import { timeTravelRoutes } from './routes/time-travel';
import type { TimeTravelService } from './services/time-travel';
import type { NotificationService } from './services/notifications';
import { notificationRoutes } from './routes/notifications';
export function createApp(
  deps: HealthDependencies,
  origins = ['http://localhost:3000'],
  level = 'info',
  authService?: AuthService,
  runService?: RunService,
  chaosService?: ChaosService,
  moderationService?: ModerationService,
  timeTravelService?: TimeTravelService,
  notificationService?: NotificationService,
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
    if (notificationService)
      app.use(
        '/notifications',
        notificationRoutes(notificationService, authService, origins),
      );
    if (timeTravelService)
      app.use(
        '/runs',
        timeTravelRoutes(timeTravelService, authService, origins),
      );
    app.use(
      '/moderation',
      moderationRoutes(
        moderationService ?? new ModerationService(runService),
        authService,
        origins,
      ),
    );
    const policyService = new PolicyService(runService.repository.policies());
    app.use('/policies', policyRoutes(policyService, authService, origins));
    app.use('/analytics', analyticsRoutes(policyService, authService));
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
