import { Router } from 'express';
import { moderationUploadSchema, runIdParamsSchema } from '@unkillable/shared';
import type { AuthService } from '../services/auth';
import type { ModerationService } from '../services/moderation';
import { requireAuth, trustedOrigin } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  uploadContent,
  listContent,
  downloadContent,
} from '../controllers/moderation';
export function moderationRoutes(
  service: ModerationService,
  auth: AuthService,
  origins: string[],
) {
  const router = Router();
  router.use(requireAuth(auth, 'moderation:manage'));
  router.get('/', listContent(service));
  router.get(
    '/:id/content',
    validate(runIdParamsSchema, 'params'),
    downloadContent(service),
  );
  router.post(
    '/uploads',
    trustedOrigin(origins),
    validate(moderationUploadSchema, 'query'),
    uploadContent(service),
  );
  return router;
}
