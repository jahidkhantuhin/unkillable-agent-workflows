import express, { Router } from 'express';
import { whatsappPreferenceSchema } from '@unkillable/shared';
import { NotificationConflict } from '@unkillable/storage';
import type { WhatsAppService } from '../services/whatsapp';
import type { AuthService } from '../services/auth';
import { requireAuth, trustedOrigin } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { notificationAction, reviewer } from '../controllers/notifications';
import { HttpError } from '../errors';
export function whatsappWebhookRoutes(service: WhatsAppService) {
  const router = Router();
  for (const status of [false, true])
    router.post(
      status ? '/status' : '/webhook',
      express.urlencoded({
        extended: false,
        limit: '64kb',
        parameterLimit: 100,
      }),
      async (req, res) => {
        if (!req.is('application/x-www-form-urlencoded'))
          throw new HttpError(
            415,
            'INVALID_TWILIO_BODY',
            'Use form-encoded Twilio requests',
          );
        const params = service.verify(
          req.get('x-twilio-signature'),
          req.body,
          status,
        );
        try {
          const response = status
            ? await service.statusWebhook(params)
            : await service.webhook(params);
          res.setHeader('Cache-Control', 'no-store');
          res.type('text/xml').send(response);
        } catch (error) {
          if (error instanceof NotificationConflict)
            throw new HttpError(409, 'WHATSAPP_CONFLICT', error.message);
          throw error;
        }
      },
    );
  return router;
}
export function whatsappSettingsRoutes(
  service: WhatsAppService,
  auth: AuthService,
  origins: string[],
) {
  const router = Router();
  router.use(requireAuth(auth, 'approvals:resolve'));
  router.get(
    '/settings',
    notificationAction((_req, res) => service.settings(reviewer(res))),
  );
  router.use(trustedOrigin(origins));
  router.post(
    '/settings',
    validate(whatsappPreferenceSchema),
    notificationAction((_req, res) =>
      service.preferences(reviewer(res), res.locals.body.enabled),
    ),
  );
  router.post(
    '/link',
    notificationAction((_req, res) => service.pairing(reviewer(res))),
  );
  router.post(
    '/unlink',
    notificationAction((_req, res) => service.unlink(reviewer(res))),
  );
  router.post(
    '/test',
    notificationAction((_req, res) => service.test(reviewer(res))),
  );
  router.post(
    '/resend',
    notificationAction((_req, res) => service.resend(reviewer(res))),
  );
  return router;
}
