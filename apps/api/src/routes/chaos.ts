import { Router } from 'express';
import { trustedOrigin, requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  killProcessSchema,
  injectFaultSchema,
  clearFaultSchema,
  llmFaultSchema,
} from '@unkillable/shared';
import type { AuthService } from '../services/auth';
import type { ChaosService } from '../services/chaos';
export function chaosRoutes(
  service: ChaosService,
  auth: AuthService,
  origins: string[],
) {
  const router = Router();
  router.get('/mode', requireAuth(auth), (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ enabled: service.enabled });
  });
  router.use(requireAuth(auth, 'chaos:manage'));
  router.get('/status', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await service.status());
  });
  router.use(trustedOrigin(origins));
  router.post('/kill', validate(killProcessSchema), async (_req, res) => {
    res
      .status(202)
      .json(await service.kill(res.locals.body, res.locals.identity.user.id));
  });
  router.post('/fault', validate(injectFaultSchema), async (_req, res) => {
    res
      .status(202)
      .json(await service.inject(res.locals.body, res.locals.identity.user.id));
  });
  router.post('/clear', validate(clearFaultSchema), async (_req, res) => {
    res.json(await service.clear(res.locals.body, res.locals.identity.user.id));
  });
  router.post('/llm', validate(llmFaultSchema), async (_req, res) => {
    res.json(await service.llm(res.locals.body));
  });
  return router;
}
