import nodemailer from 'nodemailer';
import {
  supportMailSchema,
  supportConfigSchema,
  RetryableError,
  PermanentError,
  type SupportConfig,
  type SupportMail,
} from '@unkillable/shared';
import type { RunRepository } from '@unkillable/storage';
import {
  MockLLM,
  LocalPolicyRetriever,
  type LLM,
  type Retriever,
  type SupportDependencies,
} from '@unkillable/workflows/support';
export class MailpitMailer {
  private readonly transport;
  constructor(config: SupportConfig) {
    config = supportConfigSchema.parse(config);
    this.transport = nodemailer.createTransport({
      host: config.MAILPIT_SMTP_HOST,
      port: config.MAILPIT_SMTP_PORT,
      secure: false,
      ignoreTLS: true,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10000,
    });
  }
  async deliver(input: SupportMail) {
    const mail = supportMailSchema.parse(input);
    try {
      await this.transport.sendMail({
        from: 'support@unkillable.test',
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        messageId: mail.messageId,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'responseCode' in error
          ? Number(error.responseCode)
          : 0;
      if (code >= 500)
        throw new PermanentError('Mailpit rejected the local message');
      throw new RetryableError('Local Mailpit SMTP unavailable');
    }
  }
  close() {
    this.transport.close();
  }
}
export function supportDependencies(
  repository: RunRepository,
  config: SupportConfig,
  deliver: (mail: SupportMail) => Promise<void>,
): SupportDependencies {
  const store = repository.support();
  const reliability = repository.reliability();
  let remoteModel: Promise<LLM> | undefined;
  const model = () =>
    (remoteModel ??= import('@unkillable/workflows/support-providers').then(
      (module) => module.createLLM(config),
    ));
  let remoteRetriever: Promise<Retriever> | undefined;
  const retriever = () =>
    (remoteRetriever ??= import('@unkillable/workflows/support-providers').then(
      (module) => module.createRetriever(config),
    ));
  return {
    llm:
      config.SUPPORT_LLM_PROVIDER === 'mock'
        ? new MockLLM()
        : {
            classify: async (ticket) => (await model()).classify(ticket),
            draft: async (ticket, policies) =>
              (await model()).draft(ticket, policies),
          },
    retriever:
      config.ORGMIND_RETRIEVER_ENABLED === 'false'
        ? new LocalPolicyRetriever()
        : {
            retrieve: async (ticket, classification) =>
              (await retriever()).retrieve(ticket, classification),
          },
    payments: store,
    tickets: store,
    mailer: {
      async send(runId, ticketId, mail) {
        const receipt = await store.queueEmail(runId, ticketId, mail);
        await reliability.deliverEmail(`${runId}:send_email:reply`, deliver);
        return receipt;
      },
    },
  };
}
