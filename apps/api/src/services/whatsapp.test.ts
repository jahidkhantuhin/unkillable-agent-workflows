import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { whatsappConfigSchema } from '@unkillable/shared';
import { WhatsAppService, twiml } from './whatsapp';
import type { WhatsAppRepository } from '@unkillable/storage';
import type { NotificationService } from './notifications';
const config = whatsappConfigSchema.parse({
  WHATSAPP_ENABLED: 'true',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_AUTH_TOKEN: 'b'.repeat(32),
  WHATSAPP_WEBHOOK_URL: 'https://example.test/api/whatsapp/webhook',
});
const service = new WhatsAppService(
  {} as WhatsAppRepository,
  {} as NotificationService,
  config,
);
describe('WhatsApp security configuration', () => {
  it('defaults off and refuses incomplete credentials or non-HTTPS callbacks', () => {
    expect(whatsappConfigSchema.parse({}).WHATSAPP_ENABLED).toBe('false');
    expect(
      whatsappConfigSchema.safeParse({ WHATSAPP_ENABLED: 'true' }).success,
    ).toBe(false);
    for (const url of [
      'http://example.test/api/whatsapp/webhook',
      'https://example.test/wrong',
      'https://example.test/api/whatsapp/webhook?x=1',
    ])
      expect(
        whatsappConfigSchema.safeParse({ ...config, WHATSAPP_WEBHOOK_URL: url })
          .success,
      ).toBe(false);
  });
  it('authenticates the exact public URL and every form field before parsing commands', () => {
    const params = {
      AccountSid: config.TWILIO_ACCOUNT_SID,
      Body: 'HELLO',
      ExtraProviderField: 'retained',
    };
    const signature = createHmac('sha1', config.TWILIO_AUTH_TOKEN)
      .update(
        config.WHATSAPP_WEBHOOK_URL +
          Object.keys(params)
            .sort()
            .map((key) => key + params[key as keyof typeof params])
            .join(''),
      )
      .digest('base64');
    expect(service.verify(signature, params)).toEqual(params);
    expect(() =>
      service.verify(signature, { ...params, ExtraProviderField: 'tampered' }),
    ).toThrow();
    expect(() => service.verify(signature, params, true)).toThrow();
    expect(() =>
      service.verify(signature, { ...params, Body: ['HELLO', 'APPROVE'] }),
    ).toThrow();
  });
  it('escapes message content in TwiML', () => {
    expect(twiml('<script>&')).toContain('&lt;script&gt;&amp;');
  });
});
