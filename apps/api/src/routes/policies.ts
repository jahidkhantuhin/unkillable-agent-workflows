import { Router } from 'express';
import {
  dryRunPolicySchema,
  saveApprovalPolicySchema,
} from '@unkillable/shared';
import type { AuthService } from '../services/auth';
import type { PolicyService } from '../services/policies';
import { requireAuth, trustedOrigin } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  listPolicies,
  savePolicy,
  dryRunPolicy,
  getAnalytics,
} from '../controllers/policies';
export function policyRoutes(
  service: PolicyService,
  auth: AuthService,
  origins: string[],
) {
  const router = Router();
  router.get('/', requireAuth(auth, 'policies:manage'), listPolicies(service));
  router.post(
    '/',
    requireAuth(auth, 'policies:manage'),
    trustedOrigin(origins),
    validate(saveApprovalPolicySchema),
    savePolicy(service),
  );
  router.post(
    '/dry-run',
    requireAuth(auth, 'policies:manage'),
    trustedOrigin(origins),
    validate(dryRunPolicySchema),
    dryRunPolicy(service),
  );
  return router;
}
export function analyticsRoutes(service: PolicyService, auth: AuthService) {
  const router = Router();
  router.get('/', requireAuth(auth, 'analytics:read'), getAnalytics(service));
  return router;
}
