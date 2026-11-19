import { z } from 'zod';
export const notificationConfigFields = {
  WEB_PUBLIC_URL: z
    .url()
    .default('http://localhost:3000')
    .refine((v) => {
      const url = new URL(v);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    }, 'Use an HTTP(S) web URL without credentials')
    .transform((v) => new URL(v).origin),
  APPROVAL_LINK_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(3600)
    .default(900),
  TELEGRAM_ENABLED: z.enum(['true', 'false']).default('false'),
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_BOT_USERNAME: z.string().default(''),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(''),
};
export const notificationConfigSchema = z
  .object(notificationConfigFields)
  .superRefine((c, ctx) => {
    if (
      c.TELEGRAM_ENABLED === 'true' &&
      (!/^\d+:[A-Za-z0-9_-]+$/.test(c.TELEGRAM_BOT_TOKEN) ||
        !/^[A-Za-z0-9_]{5,32}$/.test(c.TELEGRAM_BOT_USERNAME) ||
        !/^[A-Za-z0-9_-]{32,256}$/.test(c.TELEGRAM_WEBHOOK_SECRET))
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Enabled Telegram requires a bot token, username and a private webhook secret (32–256 URL-safe characters).',
      });
  });
export type NotificationConfig = z.infer<typeof notificationConfigSchema>;
export const notificationPreferenceRecordSchema = z.object({
  userId: z.string().min(1).max(128),
  telegram: z.boolean(),
  telegramUserId: z.string().regex(/^\d+$/).optional(),
  chatId: z.string().regex(/^\d+$/).optional(),
});
export const notificationPreferencesSchema = z.strictObject({
  telegram: z.boolean(),
});
export const notificationSettingsSchema = z.object({
  web: z.literal(true),
  telegram: z.boolean(),
  linked: z.boolean(),
  telegramAvailable: z.boolean(),
  botUsername: z.string(),
  linkTtlSeconds: z.number(),
});
export const signedDecisionSchema = z.strictObject({
  v: z.literal(1),
  jti: z.uuid(),
  actorId: z.string().min(1).max(128),
  approvalId: z.uuid(),
  version: z.number().int().nonnegative(),
  action: z.enum(['approve', 'reject']),
  exp: z.number().int().positive(),
});
export type SignedDecision = z.infer<typeof signedDecisionSchema>;
export const signedTokenBodySchema = z.strictObject({
  token: z.string().min(30).max(2000),
});
export const approvalLinksSchema = z.object({
  approve: z.url(),
  reject: z.url(),
  expiresAt: z.string(),
});
export const signedPreviewSchema = z.object({
  action: z.enum(['approve', 'reject']),
  expiresAt: z.string(),
  approval: z.record(z.string(), z.unknown()),
});
export const telegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      text: z.string().max(4096).optional(),
      from: z
        .object({
          id: z.number().int().positive(),
          is_bot: z.boolean().optional(),
        })
        .optional(),
      chat: z.object({ id: z.number().int(), type: z.string() }),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string().max(256),
      data: z.string().max(64).optional(),
      from: z.object({
        id: z.number().int().positive(),
        is_bot: z.boolean().optional(),
      }),
      message: z
        .object({ chat: z.object({ id: z.number().int(), type: z.string() }) })
        .optional(),
    })
    .optional(),
});
