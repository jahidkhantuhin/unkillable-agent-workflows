import { Router } from 'express';
import {
  notificationPreferencesSchema,
  signedTokenBodySchema,
  runIdParamsSchema,
} from '@unkillable/shared';
import type { NotificationService } from '../services/notifications';
import type { AuthService } from '../services/auth';
import { requireAuth, trustedOrigin } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { notificationAction, reviewer } from '../controllers/notifications';
export function notificationRoutes(
  service: NotificationService,
  auth: AuthService,
  origins: string[],
) {
  const router = Router();
  router.post(
    '/telegram/webhook',
    (req, _res, next) => {
      service.webhookAllowed(req.get('x-telegram-bot-api-secret-token'));
      next();
    },
    notificationAction((req) => service.webhook(req.body)),
  );
  router.use(requireAuth(auth, 'approvals:resolve'));
  router.get(
    '/settings',
    notificationAction((_req, res) => service.settings(reviewer(res))),
  );
  router.use(trustedOrigin(origins));
  router.post(
    '/settings',
    validate(notificationPreferencesSchema),
    notificationAction((_req, res) =>
      service.preferences(reviewer(res), res.locals.body.telegram),
    ),
  );
  router.post(
    '/telegram/link',
    notificationAction((_req, res) => service.pairing(reviewer(res))),
  );
  router.post(
    '/telegram/unlink',
    notificationAction((_req, res) => service.unlink(reviewer(res))),
  );
  router.post(
    '/links/inspect',
    validate(signedTokenBodySchema),
    notificationAction((_req, res) =>
      service.inspect(reviewer(res), res.locals.body.token),
    ),
  );
  router.post(
    '/links/resolve',
    validate(signedTokenBodySchema),
    notificationAction((_req, res) =>
      service.resolve(reviewer(res), res.locals.body.token),
    ),
  );
  router.post(
    '/links/:id',
    validate(runIdParamsSchema, 'params'),
    notificationAction((_req, res) =>
      service.links(reviewer(res), res.locals.params.id),
    ),
  );
  return router;
}
