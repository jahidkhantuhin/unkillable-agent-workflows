import { z } from 'zod';
export const whatsappAddressSchema = z
  .string()
  .regex(/^whatsapp:\+[1-9]\d{7,14}$/);
export const whatsappConfigFields = {
  WHATSAPP_ENABLED: z.enum(['true', 'false']).default('false'),
  TWILIO_ACCOUNT_SID: z.string().default(''),
  TWILIO_AUTH_TOKEN: z.string().default(''),
  TWILIO_WHATSAPP_FROM: z.string().default('whatsapp:+14155238886'),
  WHATSAPP_WEBHOOK_URL: z.string().default(''),
};
export const whatsappConfigSchema = z
  .object(whatsappConfigFields)
  .superRefine((c, ctx) => {
    if (c.WHATSAPP_ENABLED !== 'true') return;
    if (
      !/^AC[a-fA-F0-9]{32}$/.test(c.TWILIO_ACCOUNT_SID) ||
      !/^[a-fA-F0-9]{32}$/.test(c.TWILIO_AUTH_TOKEN) ||
      !whatsappAddressSchema.safeParse(c.TWILIO_WHATSAPP_FROM).success
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'WhatsApp requires a Twilio Account SID, Auth Token and WhatsApp sender from your console.',
      });
    try {
      const u = new URL(c.WHATSAPP_WEBHOOK_URL);
      if (
        u.protocol !== 'https:' ||
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        !['/api/whatsapp/webhook', '/notifications/whatsapp/webhook'].includes(
          u.pathname,
        )
      )
        throw new Error();
    } catch {
      ctx.addIssue({
        code: 'custom',
        message:
          'WHATSAPP_WEBHOOK_URL must be the exact public HTTPS URL ending /api/whatsapp/webhook or /notifications/whatsapp/webhook, without query or credentials.',
      });
    }
  });
export type WhatsAppConfig = z.infer<typeof whatsappConfigSchema>;
export const whatsappPreferenceSchema = z.strictObject({
  enabled: z.boolean(),
});
export const whatsappConnectionSchema = z.object({
  userId: z.string(),
  phone: whatsappAddressSchema,
  enabled: z.boolean(),
  lastInboundAt: z.date(),
  linkedAt: z.date(),
});
export const whatsappSettingsSchema = z.object({
  available: z.boolean(),
  linked: z.boolean(),
  enabled: z.boolean(),
  sender: z.string(),
  phoneMasked: z.string(),
  windowOpen: z.boolean(),
  windowExpiresAt: z.string().nullable(),
  lastStatus: z.string().nullable(),
  lastError: z.string().nullable(),
});
export const twilioFormSchema = z.record(z.string(), z.string().max(10000));
export const whatsappInboundSchema = z.object({
  AccountSid: z.string(),
  MessageSid: z.string().regex(/^(SM|MM)[a-fA-F0-9]{32}$/),
  From: whatsappAddressSchema,
  To: whatsappAddressSchema,
  Body: z.string().max(4096).default(''),
});
export const whatsappStatusSchema = z.object({
  AccountSid: z.string(),
  MessageSid: z.string().regex(/^(SM|MM)[a-fA-F0-9]{32}$/),
  MessageStatus: z.enum([
    'accepted',
    'queued',
    'sending',
    'sent',
    'delivered',
    'read',
    'failed',
    'undelivered',
    'canceled',
  ]),
  ErrorCode: z.string().regex(/^\d*$/).optional(),
});
export const whatsappDecisionRecordSchema = z.object({
  hash: z.string(),
  userId: z.string(),
  phone: whatsappAddressSchema,
  approvalId: z.uuid(),
  approveId: z.uuid(),
  rejectId: z.uuid(),
  expiresAt: z.date(),
});
export const whatsappWindowMs = 24 * 60 * 60 * 1000;
