import type { RequestHandler } from 'express';
import { getHealth, type HealthDependencies } from '../services/health';
export const healthController =
  (deps: HealthDependencies): RequestHandler =>
  async (_req, res) => {
    const health = await getHealth(deps);
    res.status(health.status === 'ok' ? 200 : 503).json(health);
  };
