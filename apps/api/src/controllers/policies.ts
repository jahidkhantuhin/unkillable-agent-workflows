import type { RequestHandler } from 'express';
import type { PolicyService } from '../services/policies';
export function listPolicies(service: PolicyService): RequestHandler {
  return async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await service.list());
  };
}
export function savePolicy(service: PolicyService): RequestHandler {
  return async (_req, res) => {
    res.json(
      await service.save(
        res.locals.body.expectedVersion,
        res.locals.body.policy,
        res.locals.identity.user.id,
      ),
    );
  };
}
export function dryRunPolicy(service: PolicyService): RequestHandler {
  return async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await service.dryRun(res.locals.body.policy));
  };
}
export function getAnalytics(service: PolicyService): RequestHandler {
  return async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await service.analytics());
  };
}
