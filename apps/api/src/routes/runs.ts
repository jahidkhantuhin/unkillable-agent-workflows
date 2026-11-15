import { Router } from 'express';
import {
  createRunSchema,
  runIdParamsSchema,
  runQuerySchema,
} from '@unkillable/shared';
import { requireAuth, trustedOrigin } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  createRun,
  getRun,
  listRuns,
  streamRun,
  getReliability,
  getGraph,
} from '../controllers/runs';
import type { RunService } from '../services/runs';
import type { AuthService } from '../services/auth';
export function runsRoutes(
  service: RunService,
  auth: AuthService,
  origins: string[],
) {
  const router = Router();
  router.get(
    '/',
    requireAuth(auth, 'runs:read'),
    validate(runQuerySchema, 'query'),
    listRuns(service),
  );
  router.post(
    '/',
    requireAuth(auth, 'runs:create'),
    trustedOrigin(origins),
    validate(createRunSchema),
    createRun(service),
  );
  router.get(
    '/:id',
    requireAuth(auth, 'runs:read'),
    validate(runIdParamsSchema, 'params'),
    getRun(service),
  );
  router.get(
    '/:id/events',
    requireAuth(auth, 'runs:read'),
    validate(runIdParamsSchema, 'params'),
    streamRun(service, auth),
  );
  router.get(
    '/:id/reliability',
    requireAuth(auth, 'runs:read'),
    validate(runIdParamsSchema, 'params'),
    getReliability(service),
  );
  router.get(
    '/:id/graph',
    requireAuth(auth, 'runs:read'),
    validate(runIdParamsSchema, 'params'),
    getGraph(service),
  );
  return router;
}
