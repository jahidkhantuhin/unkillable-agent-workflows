import { Router } from 'express';
import { ticketInputSchema } from '@unkillable/shared';
import type { AuthService } from '../services/auth';
import type { RunService } from '../services/runs';
import { requireAuth, trustedOrigin } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { createTicket, ticketExamples } from '../controllers/tickets';
export function ticketRoutes(
  service: RunService,
  auth: AuthService,
  origins: string[],
) {
  const router = Router();
  router.get(
    '/examples',
    requireAuth(auth, 'runs:read'),
    ticketExamples(service),
  );
  router.post(
    '/',
    requireAuth(auth, 'runs:create'),
    trustedOrigin(origins),
    validate(ticketInputSchema),
    createTicket(service),
  );
  return router;
}
