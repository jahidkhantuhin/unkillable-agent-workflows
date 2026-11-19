import { createHash, randomBytes } from 'node:crypto';
import twilio from 'twilio';
import {
  twilioFormSchema,
  whatsappInboundSchema,
  whatsappStatusSchema,
  whatsappSettingsSchema,
  whatsappWindowMs,
  type WhatsAppConfig,
} from '@unkillable/shared';
import { WhatsAppRepository, NotificationConflict } from '@unkillable/storage';
import { tokenHash, InvalidApprovalLink } from './approval-signing';
import type { NotificationService, Reviewer } from './notifications';
import { HttpError } from '../errors';
export function whatsAppError(code?: number) {
  return code === 63015
    ? 'Join your Twilio WhatsApp sandbox from this phone before sending a test.'
    : code === 63016
      ? 'Send HELLO from WhatsApp to reopen the 24-hour reply window.'
      : code === 20003
        ? 'Twilio authentication failed. Check your local Account SID and Auth Token.'
        : code === 20429
          ? 'Twilio rate limit reached. Wait before requesting another message.'
          : `WhatsApp delivery unavailable${code ? ` (Twilio code ${code})` : ''}. Check the Twilio message log.`;
}
export interface WhatsAppTransport {
  send(to: string, text: string): Promise<{ sid: string; status: string }>;
}
export class TwilioWhatsApp implements WhatsAppTransport {
  constructor(private readonly config: WhatsAppConfig) {}
  async send(to: string, text: string) {
    try {
      const client = twilio(
        this.config.TWILIO_ACCOUNT_SID,
        this.config.TWILIO_AUTH_TOKEN,
        { timeout: 10000, autoRetry: false },
      );
      const message = await client.messages.create({
        from: this.config.TWILIO_WHATSAPP_FROM,
        to,
        body: text,
        statusCallback: this.config.WHATSAPP_WEBHOOK_URL.replace(
          /\/webhook$/,
          '/status',
        ),
      });
      return { sid: message.sid, status: String(message.status) };
    } catch (error) {
      const code =
        error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'number'
          ? error.code
          : undefined;
      // The provider error may contain credentials/request details; expose only a safe message.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(whatsAppError(code));
    }
  }
}
export function twiml(text = '') {
  const escaped = text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${text ? `<Message>${escaped}</Message>` : ''}</Response>`;
}
export class WhatsAppService {
  private delivering = false;
  constructor(
    readonly store: WhatsAppRepository,
    private readonly notifications: NotificationService,
    readonly config: WhatsAppConfig,
    private readonly transport: WhatsAppTransport = new TwilioWhatsApp(config),
    private readonly now: () => number = Date.now,
  ) {}
  private enabled() {
    if (this.config.WHATSAPP_ENABLED !== 'true')
      throw new HttpError(
        404,
        'WHATSAPP_DISABLED',
        'WhatsApp is disabled. Web and Telegram approvals remain available.',
      );
  }
  private async actor(id: string) {
    return this.notifications.current({ id, role: 'viewer' });
  }
  private window(connection: { lastInboundAt: Date }) {
    return connection.lastInboundAt.getTime() + whatsappWindowMs > this.now();
  }
  verify(signature: string | undefined, body: unknown, status = false) {
    this.enabled();
    const params = twilioFormSchema.parse(body);
    const url = status
      ? this.config.WHATSAPP_WEBHOOK_URL.replace(/\/webhook$/, '/status')
      : this.config.WHATSAPP_WEBHOOK_URL;
    if (
      !signature ||
      !twilio.validateRequest(
        this.config.TWILIO_AUTH_TOKEN,
        signature,
        url,
        params,
      )
    )
      throw new HttpError(
        403,
        'INVALID_WHATSAPP_SIGNATURE',
        'WhatsApp signature validation failed. Check the exact public webhook URL configuration.',
      );
    if (params.AccountSid !== this.config.TWILIO_ACCOUNT_SID)
      throw new HttpError(
        403,
        'WRONG_TWILIO_ACCOUNT',
        'Invalid WhatsApp account',
      );
    return params;
  }
  async settings(actor: Reviewer) {
    await this.actor(actor.id);
    const connection = await this.store.connection(actor.id),
      message = await this.store.lastMessage(actor.id);
    const error = message?.errorCode
      ? whatsAppError(Number(message.errorCode))
      : await this.store.lastError(actor.id);
    return whatsappSettingsSchema.parse({
      available: this.config.WHATSAPP_ENABLED === 'true',
      linked: !!connection,
      enabled: connection?.enabled ?? false,
      sender: this.config.TWILIO_WHATSAPP_FROM,
      phoneMasked: connection ? `•••• ${connection.phone.slice(-4)}` : '',
      windowOpen: connection ? this.window(connection) : false,
      windowExpiresAt: connection
        ? new Date(
            connection.lastInboundAt.getTime() + whatsappWindowMs,
          ).toISOString()
        : null,
      lastStatus: message?.status ?? null,
      lastError: error,
    });
  }
  async preferences(actor: Reviewer, enabled: boolean) {
    await this.actor(actor.id);
    if (enabled) this.enabled();
    if (!(await this.store.connection(actor.id)))
      throw new HttpError(
        400,
        'WHATSAPP_NOT_LINKED',
        'Link your WhatsApp number first',
      );
    await this.store.preferences(actor.id, enabled);
    return this.settings(actor);
  }
  async pairing(actor: Reviewer) {
    await this.actor(actor.id);
    this.enabled();
    const code = randomBytes(24).toString('base64url');
    await this.store.pairing(actor.id, tokenHash(code));
    const command = `LINK ${code}`;
    return {
      command,
      url: `https://wa.me/${this.config.TWILIO_WHATSAPP_FROM.replace('whatsapp:+', '')}?text=${encodeURIComponent(command)}`,
      expiresInSeconds: 600,
    };
  }
  async unlink(actor: Reviewer) {
    await this.actor(actor.id);
    await this.store.unlink(actor.id);
    return this.settings(actor);
  }
  private async ready(actor: Reviewer) {
    await this.actor(actor.id);
    this.enabled();
    const connection = await this.store.connection(actor.id);
    if (!connection?.enabled)
      throw new HttpError(
        409,
        'WHATSAPP_NOT_READY',
        'Link and enable your WhatsApp number first',
      );
    if (!this.window(connection))
      throw new HttpError(
        409,
        'WHATSAPP_WINDOW_CLOSED',
        'Send HELLO from WhatsApp to reopen the 24-hour reply window',
      );
    return connection;
  }
  private async send(userId: string, phone: string, text: string) {
    try {
      const sent = await this.transport.send(phone, text);
      await this.store.track(sent.sid, userId);
      await this.store.status(sent.sid, sent.status);
      await this.store.clearError(userId);
      return sent;
    } catch (error) {
      await this.store.failure(userId, (error as Error).message);
      throw error;
    }
  }
  async test(actor: Reviewer) {
    const connection = await this.ready(actor);
    if (!(await this.store.manualSlot(actor.id)))
      throw new HttpError(
        429,
        'WHATSAPP_COOLDOWN',
        'Wait one minute before another test or resend request',
      );
    const sent = await this.send(
      actor.id,
      connection.phone,
      'Unkillable WhatsApp test: your private approval channel is connected. This message does not approve a workflow or move real money.',
    );
    return { accepted: true, status: sent.status };
  }
  async resend(actor: Reviewer) {
    await this.ready(actor);
    if (!(await this.store.manualSlot(actor.id)))
      throw new HttpError(
        429,
        'WHATSAPP_COOLDOWN',
        'Wait one minute before another test or resend request',
      );
    await this.store.refresh(actor.id);
    return { scheduled: true };
  }
  async webhook(params: Record<string, string>) {
    this.enabled();
    const message = whatsappInboundSchema.parse(params);
    if (message.To !== this.config.TWILIO_WHATSAPP_FROM)
      throw new HttpError(
        403,
        'WRONG_WHATSAPP_RECIPIENT',
        'Invalid WhatsApp recipient',
      );
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(message))
      .digest('hex');
    const receipt = await this.store.inbound(message.MessageSid, fingerprint);
    if (receipt.response !== null) return receipt.response;
    if (!receipt.claimed)
      throw new HttpError(
        503,
        'WHATSAPP_IN_PROGRESS',
        'This message is already being processed; retry shortly',
      );
    let text: string;
    try {
      text = await this.command(message.From, message.Body.trim());
    } catch (error) {
      if (
        error instanceof NotificationConflict ||
        error instanceof InvalidApprovalLink ||
        error instanceof HttpError
      )
        text = error.message;
      else if ((error as { code?: number }).code === 11000)
        text =
          'This number is already connected. Unlink it from the other account first.';
      else throw error;
    }
    const response = twiml(text);
    await this.store.inboundDone(message.MessageSid, response);
    return response;
  }
  private async command(phone: string, body: string) {
    const link = /^LINK ([A-Za-z0-9_-]{32})$/i.exec(body);
    if (link) {
      const hash = tokenHash(link[1]),
        userId = await this.store.pairingOwner(hash);
      if (!userId) throw new NotificationConflict();
      await this.actor(userId);
      await this.store.pair(hash, phone);
      return 'WhatsApp linked to your Unkillable reviewer account. Approval notifications are enabled. Reply HELP for commands. Only synthetic local demo effects are supported.';
    }
    const connection = await this.store.byPhone(phone);
    if (!connection)
      return 'Connect this phone from Unkillable Notification settings first. Join your Twilio WhatsApp testing environment before sending its LINK command.';
    await this.store.touch(phone);
    if (/^STOP$/i.test(body)) {
      await this.store.preferences(connection.userId, false);
      return 'WhatsApp approval notifications paused. Web and Telegram preferences are unchanged.';
    }
    if (/^UNLINK$/i.test(body)) {
      await this.store.unlink(connection.userId);
      return 'WhatsApp unlinked. Web approvals remain available.';
    }
    const actor = await this.actor(connection.userId);
    if (/^START$/i.test(body)) {
      await this.store.preferences(actor.id, true);
      return 'WhatsApp approval notifications enabled. Reply PENDING for current requests.';
    }
    if (!connection.enabled)
      return 'WhatsApp approval notifications are paused. Reply START or enable them in Notification settings.';
    if (/^PENDING$/i.test(body)) {
      await this.resend(actor);
      return 'Current pending approval notifications scheduled. New codes will arrive shortly; resolved requests are not reopened.';
    }
    const decision = /^(APPROVE|REJECT|EDIT) ([A-Za-z0-9_-]{12})$/i.exec(body);
    if (decision) {
      const record = await this.store.findDecision(
        tokenHash(decision[2]),
        phone,
      );
      if (!record || record.userId !== actor.id)
        throw new NotificationConflict();
      if (decision[1].toUpperCase() === 'EDIT')
        return `Review or edit this proposal while signed in: ${this.notifications.config.WEB_PUBLIC_URL}/approvals#approval-${record.approvalId}`;
      const result = await this.notifications.resolveChannel(
        actor,
        decision[1].toUpperCase() === 'APPROVE'
          ? record.approveId
          : record.rejectId,
        'whatsapp',
      );
      return `Review recorded. A second reviewer may still be required. Follow the run: ${this.notifications.config.WEB_PUBLIC_URL}/runs/${result.runId}`;
    }
    return 'Unkillable WhatsApp is connected. Reply APPROVE <code> or REJECT <code> from an approval message. EDIT <code> opens the full review. PENDING resends current requests. STOP pauses, START resumes, and UNLINK disconnects.';
  }
  async statusWebhook(params: Record<string, string>) {
    this.enabled();
    const status = whatsappStatusSchema.parse(params);
    await this.store.status(
      status.MessageSid,
      status.MessageStatus,
      status.ErrorCode,
    );
    return twiml();
  }
  async deliver() {
    if (this.config.WHATSAPP_ENABLED !== 'true' || this.delivering) return;
    this.delivering = true;
    try {
      for (const connection of await this.store.connections()) {
        if (!this.window(connection)) continue;
        let actor: Reviewer;
        try {
          actor = await this.actor(connection.userId);
        } catch (error) {
          if (error instanceof HttpError) continue;
          throw error;
        }
        for (const approval of await this.notifications.pendingFor(actor)) {
          const key = await this.store.claim(
            approval.id,
            approval.version,
            actor.id,
          );
          if (!key) continue;
          const bundle = await this.notifications.channelDecisions(
              actor,
              approval.id,
            ),
            code = randomBytes(9).toString('base64url');
          if (bundle.approval.version !== approval.version) continue;
          await this.store.decision({
            hash: tokenHash(code),
            userId: actor.id,
            phone: connection.phone,
            approvalId: approval.id,
            approveId: bundle.approveId,
            rejectId: bundle.rejectId,
            expiresAt: bundle.expiresAt,
          });
          const current = await this.store.connection(actor.id);
          if (
            !current?.enabled ||
            current.phone !== connection.phone ||
            !this.window(current)
          )
            continue;
          await this.actor(actor.id);
          const a = bundle.approval,
            refund =
              a.proposedAction.kind === 'support-ticket'
                ? `\nProposed fake refund: USD ${(Number(a.proposedAction.refundCents) / 100).toFixed(2)}.`
                : '';
          await this.send(
            actor.id,
            connection.phone,
            `${a.title || 'Unkillable approval'}${refund}\nDraft: ${String(a.proposedAction.message).slice(0, 500)}\nReviews ${a.reviews.length}/${a.requiredApprovals}. Local demo effects only.\nReply APPROVE ${code} or REJECT ${code}.\nEDIT ${code} to review/edit online. Code expires ${bundle.expiresAt.toISOString()}.\nReply PENDING for fresh requests. STOP to pause.`,
          );
          await this.store.sent(key);
        }
      }
    } finally {
      this.delivering = false;
    }
  }
}
