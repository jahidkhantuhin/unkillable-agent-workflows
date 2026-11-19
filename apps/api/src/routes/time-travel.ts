import { Router } from 'express';
import {
  runIdParamsSchema,
  checkpointParamsSchema,
  checkpointQuerySchema,
  checkpointDiffQuerySchema,
  forkRunSchema,
} from '@unkillable/shared';
import { requireAuth, trustedOrigin } from '../middleware/auth';
import { validate } from '../middleware/validate';
import type { AuthService } from '../services/auth';
import type { TimeTravelService } from '../services/time-travel';
import {
  listCheckpoints,
  getCheckpoint,
  getStateDiff,
  getForks,
  forkRun,
} from '../controllers/time-travel';
export function timeTravelRoutes(
  service: TimeTravelService,
  auth: AuthService,
  origins: string[],
) {
  const router = Router();
  router.get(
    '/:id/checkpoints',
    requireAuth(auth, 'runs:read'),
    validate(runIdParamsSchema, 'params'),
    validate(checkpointQuerySchema, 'query'),
    listCheckpoints(service),
  );
  router.get(
    '/:id/checkpoints/:checkpointId',
    requireAuth(auth, 'runs:read'),
    validate(checkpointParamsSchema, 'params'),
    getCheckpoint(service),
  );
  router.get(
    '/:id/diff',
    requireAuth(auth, 'runs:read'),
    validate(runIdParamsSchema, 'params'),
    validate(checkpointDiffQuerySchema, 'query'),
    getStateDiff(service),
  );
  router.get(
    '/:id/forks',
    requireAuth(auth, 'runs:read'),
    validate(runIdParamsSchema, 'params'),
    getForks(service),
  );
  router.post(
    '/:id/forks',
    requireAuth(auth, 'runs:fork'),
    trustedOrigin(origins),
    validate(runIdParamsSchema, 'params'),
    validate(forkRunSchema),
    forkRun(service),
  );
  return router;
}
