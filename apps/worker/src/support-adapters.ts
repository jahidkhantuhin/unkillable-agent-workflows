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
      throw this.failure(error);
    }
  }
  /** Checks the actual SMTP listener without sending a message. */
  async verify() {
    try {
      await this.transport.verify();
    } catch (error) {
      throw this.failure(error);
    }
  }
  private failure(error: unknown) {
    const code =
      error && typeof error === 'object' && 'responseCode' in error
        ? Number(error.responseCode)
        : 0;
    const detail =
      error && typeof error === 'object'
        ? (error as { code?: unknown; command?: unknown })
        : {};
    const diagnostic = [detail.code, detail.command, code || undefined]
      .filter(
        (value) =>
          typeof value === 'number' ||
          (typeof value === 'string' && /^[A-Z0-9 _-]{1,50}$/i.test(value)),
      )
      .join(' / ');
    const message = `${code >= 500 ? 'Mailpit rejected the local message' : 'Local Mailpit SMTP unavailable'}${diagnostic ? ` (${diagnostic})` : ''}`;
    const failure =
      code >= 500 ? new PermanentError(message) : new RetryableError(message);
    failure.cause = error;
    return failure;
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
