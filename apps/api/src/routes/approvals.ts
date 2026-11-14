import { Router } from 'express';
import { resolveApprovalSchema, runIdParamsSchema } from '@unkillable/shared';
import type { AuthService } from '../services/auth';
import type { ApprovalService } from '../services/approvals';
import { requireAuth, trustedOrigin } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  listApprovals,
  getApproval,
  resolveApproval,
} from '../controllers/approvals';
export function approvalRoutes(
  service: ApprovalService,
  auth: AuthService,
  origins: string[],
) {
  const router = Router();
  router.get('/', requireAuth(auth, 'approvals:read'), listApprovals(service));
  router.get(
    '/:id',
    requireAuth(auth, 'approvals:read'),
    validate(runIdParamsSchema, 'params'),
    getApproval(service),
  );
  router.post(
    '/:id/resolve',
    requireAuth(auth, 'approvals:resolve'),
    trustedOrigin(origins),
    validate(runIdParamsSchema, 'params'),
    validate(resolveApprovalSchema),
    resolveApproval(service),
  );
  return router;
}
