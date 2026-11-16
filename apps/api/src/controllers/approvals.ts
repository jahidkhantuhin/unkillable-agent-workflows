import type { RequestHandler } from 'express';
import type { ApprovalService } from '../services/approvals';
export function listApprovals(service: ApprovalService): RequestHandler {
  return async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await service.list(res.locals.identity.role));
  };
}
export function getApproval(service: ApprovalService): RequestHandler {
  return async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await service.get(res.locals.params.id, res.locals.identity.role));
  };
}
export function resolveApproval(service: ApprovalService): RequestHandler {
  return async (_req, res) => {
    res.json(
      await service.resolve(
        res.locals.params.id,
        res.locals.body.version,
        res.locals.body.decision,
        res.locals.identity.user.id,
        res.locals.identity.role,
      ),
    );
  };
}
