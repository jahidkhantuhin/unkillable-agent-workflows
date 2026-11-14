import { Router } from 'express';
import { deadLetterActionSchema, runIdParamsSchema } from '@unkillable/shared';
import type { AuthService } from '../services/auth';
import type { DeadLetterService } from '../services/dead-letters';
import { requireAuth, trustedOrigin } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  listDeadLetters,
  getDeadLetter,
  resolveDeadLetter,
} from '../controllers/dead-letters';
export function deadLetterRoutes(
  service: DeadLetterService,
  auth: AuthService,
  origins: string[],
) {
  const router = Router();
  router.get(
    '/',
    requireAuth(auth, 'deadletters:read'),
    listDeadLetters(service),
  );
  router.get(
    '/:id',
    requireAuth(auth, 'deadletters:read'),
    validate(runIdParamsSchema, 'params'),
    getDeadLetter(service),
  );
  for (const action of ['retry', 'discard'] as const)
    router.post(
      `/:id/${action}`,
      requireAuth(auth, 'deadletters:manage'),
      trustedOrigin(origins),
      validate(runIdParamsSchema, 'params'),
      validate(deadLetterActionSchema),
      resolveDeadLetter(service, action),
    );
  return router;
}
