import { Router } from 'express';
import { healthController } from '../controllers/health';
import type { HealthDependencies } from '../services/health';
export function healthRoutes(deps: HealthDependencies) {
  const router = Router();
  router.get('/health', healthController(deps));
  return router;
}
