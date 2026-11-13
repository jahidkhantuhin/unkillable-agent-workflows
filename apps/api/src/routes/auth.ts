import { Router } from 'express';
import {
  loginSchema,
  registerSchema,
  sectionPermissions,
} from '@unkillable/shared';
import { authController, meController } from '../controllers/auth';
import { requireAuth, trustedOrigin } from '../middleware/auth';
import { validate } from '../middleware/validate';
import type { AuthService } from '../services/auth';
export function authRoutes(service: AuthService, origins: string[]) {
  const router = Router();
  router.post(
    '/register',
    trustedOrigin(origins),
    validate(registerSchema),
    authController(service, 'register'),
  );
  router.post(
    '/login',
    trustedOrigin(origins),
    validate(loginSchema),
    authController(service, 'login'),
  );
  router.post(
    '/logout',
    trustedOrigin(origins),
    authController(service, 'logout'),
  );
  router.get('/me', requireAuth(service), meController);
  for (const [section, permission] of Object.entries(sectionPermissions))
    router.get(
      `/access/${section}`,
      requireAuth(service, permission),
      meController,
    );
  return router;
}
