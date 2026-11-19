import { z } from 'zod';
import {
  infrastructureSchema,
  runQueueConfigSchema,
  notificationConfigFields,
  notificationConfigSchema,
} from '@unkillable/shared';
export const configSchema = infrastructureSchema
  .extend({
    ...runQueueConfigSchema.shape,
    ...notificationConfigFields,
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z
      .url()
      .default('http://localhost:4000')
      .transform((value) => new URL(value).origin),
    MONGODB_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\//),
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:3000')
      .transform((value) =>
        value.split(',').map((origin) => z.url().parse(origin.trim())),
      ),
  })
  .superRefine((config, context) => {
    const notifications = notificationConfigSchema.safeParse(config);
    if (!notifications.success)
      for (const issue of notifications.error.issues)
        context.addIssue({
          code: 'custom',
          message: issue.message,
          path: issue.path,
        });
    if (
      config.NODE_ENV === 'production' &&
      !config.WEB_PUBLIC_URL.startsWith('https://')
    )
      context.addIssue({
        code: 'custom',
        message: 'Production approvals require HTTPS WEB_PUBLIC_URL',
      });
    if (
      config.NODE_ENV === 'production' &&
      (config.BETTER_AUTH_SECRET.startsWith('replace-') ||
        !config.BETTER_AUTH_URL.startsWith('https://'))
    )
      context.addIssue({
        code: 'custom',
        message:
          'Production authentication requires a private secret and HTTPS BETTER_AUTH_URL',
      });
  });
