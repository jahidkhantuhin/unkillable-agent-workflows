import { beforeEach, it, expect, vi } from 'vitest';
import {
  supportConfigSchema,
  RetryableError,
  PermanentError,
} from '@unkillable/shared';
const transport = vi.hoisted(() => ({
  sendMail: vi.fn(),
  verify: vi.fn(),
  close: vi.fn(),
}));
vi.mock('nodemailer', () => ({
  default: { createTransport: () => transport },
}));
import { MailpitMailer } from './support-adapters';
const mail = {
  to: 'smtp-test@example.test',
  subject: 'Local transport test',
  text: 'Synthetic notice',
  messageId: `<${'a'.repeat(64)}@unkillable.test>`,
};
beforeEach(() => vi.resetAllMocks());
it('preserves connection diagnostics and the cause without changing retry classification', async () => {
  const source = Object.assign(new Error('Connection refused'), {
    code: 'ECONNREFUSED',
    command: 'CONN',
  });
  transport.sendMail.mockRejectedValue(source);
  const error = await new MailpitMailer(supportConfigSchema.parse({}))
    .deliver(mail)
    .catch((error) => error);
  expect(error).toBeInstanceOf(RetryableError);
  expect(error.message).toContain('ECONNREFUSED / CONN');
  expect(error.cause).toBe(source);
});
it('keeps temporary SMTP replies retryable and permanent rejection permanent', async () => {
  const smtp = new MailpitMailer(supportConfigSchema.parse({}));
  transport.sendMail.mockRejectedValueOnce({
    code: 'EENVELOPE',
    command: 'RCPT TO',
    responseCode: 451,
  });
  await expect(smtp.deliver(mail)).rejects.toBeInstanceOf(RetryableError);
  transport.sendMail.mockRejectedValueOnce({
    code: 'EENVELOPE',
    command: 'RCPT TO',
    responseCode: 550,
  });
  await expect(smtp.deliver(mail)).rejects.toBeInstanceOf(PermanentError);
});
it('probes SMTP readiness without sending any mail', async () => {
  transport.verify.mockResolvedValue(true);
  await new MailpitMailer(supportConfigSchema.parse({})).verify();
  expect(transport.verify).toHaveBeenCalledOnce();
  expect(transport.sendMail).not.toHaveBeenCalled();
});
it('reports a failed readiness probe rather than silently continuing', async () => {
  transport.verify.mockRejectedValue({ code: 'ETIMEDOUT', command: 'CONN' });
  await expect(
    new MailpitMailer(supportConfigSchema.parse({})).verify(),
  ).rejects.toThrow('ETIMEDOUT / CONN');
});
