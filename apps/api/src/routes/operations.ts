import { Router } from 'express';
import { runIdParamsSchema } from '@unkillable/shared';
import type { OperationsRepository } from '@unkillable/storage';
import type { AuthService } from '../services/auth';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { HttpError } from '../errors';
export function operationsRoutes(
  store: OperationsRepository,
  auth: AuthService,
) {
  const router = Router();
  router.get(
    '/runs/:id/metrics',
    requireAuth(auth, 'runs:read'),
    validate(runIdParamsSchema, 'params'),
    async (_req, res) => {
      const result = await store.metrics(res.locals.params.id);
      if (!result) throw new HttpError(404, 'RUN_NOT_FOUND', 'Run not found');
      res.setHeader('Cache-Control', 'no-store');
      res.json(result);
    },
  );
  router.get(
    '/analytics/costs',
    requireAuth(auth, 'analytics:read'),
    async (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await store.costs());
    },
  );
  return router;
}
