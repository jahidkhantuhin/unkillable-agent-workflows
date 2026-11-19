import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  hasPermission,
  telegramUpdateSchema,
  notificationSettingsSchema,
  type NotificationConfig,
  type Role,
  type SignedDecision,
} from '@unkillable/shared';
import {
  NotificationRepository,
  NotificationConflict,
} from '@unkillable/storage';
import type { MembershipRepository } from '../repositories/documents';
import type { ApprovalService } from './approvals';
import type { RunService } from './runs';
import {
  ApprovalSigner,
  tokenHash,
  InvalidApprovalLink,
} from './approval-signing';
import { HttpError } from '../errors';
export type Reviewer = { id: string; role: Role };
export interface TelegramTransport {
  call(
    method: 'sendMessage' | 'answerCallbackQuery',
    body: Record<string, unknown>,
  ): Promise<void>;
}
export class TelegramHTTP implements TelegramTransport {
  constructor(private readonly token: string) {}
  async call(
    method: 'sendMessage' | 'answerCallbackQuery',
    body: Record<string, unknown>,
  ) {
    // Never attach the token-bearing URL or transport exception to logs/errors.
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10000),
        },
      );
      const result = await response.json();
      if (
        !response.ok ||
        !result ||
        typeof result !== 'object' ||
        !('ok' in result) ||
        result.ok !== true
      )
        throw new Error();
    } catch {
      throw new Error(
        'Telegram delivery unavailable; the web inbox remains available.',
      );
    }
  }
}
export class NotificationService {
  private delivering = false;
  constructor(
    readonly store: NotificationRepository,
    private readonly approvals: ApprovalService,
    private readonly runs: RunService,
    private readonly memberships: MembershipRepository,
    private readonly signer: ApprovalSigner,
    readonly config: NotificationConfig,
    private readonly telegram: TelegramTransport = new TelegramHTTP(
      config.TELEGRAM_BOT_TOKEN,
    ),
    private readonly now: () => number = Date.now,
  ) {}
  private authorize(actor: Reviewer) {
    if (!hasPermission(actor.role, 'approvals:resolve'))
      throw new HttpError(
        403,
        'FORBIDDEN',
        'Approval review requires an approver or administrator',
      );
  }
  async current(actor: Reviewer) {
    const member = await this.memberships.get(actor.id);
    if (!member)
      throw new HttpError(403, 'FORBIDDEN', 'Workspace membership required');
    const fresh = { id: actor.id, role: member.role };
    this.authorize(fresh);
    return fresh;
  }
  private enabled() {
    if (this.config.TELEGRAM_ENABLED !== 'true')
      throw new HttpError(
        404,
        'TELEGRAM_DISABLED',
        'Telegram is disabled. Use the web Approval Inbox.',
      );
  }
  async settings(actor: Reviewer) {
    await this.current(actor);
    const row = await this.store.settings(actor.id);
    return notificationSettingsSchema.parse({
      web: true,
      telegram: row?.telegram ?? false,
      linked: !!row?.telegramUserId,
      telegramAvailable: this.config.TELEGRAM_ENABLED === 'true',
      botUsername: this.config.TELEGRAM_BOT_USERNAME,
      linkTtlSeconds: this.config.APPROVAL_LINK_TTL_SECONDS,
    });
  }
  async preferences(actor: Reviewer, telegram: boolean) {
    await this.current(actor);
    if (telegram) {
      this.enabled();
      if (!(await this.store.settings(actor.id))?.telegramUserId)
        throw new HttpError(
          400,
          'CHAT_NOT_LINKED',
          'Link your private Telegram chat first',
        );
    }
    await this.store.preferences(actor.id, telegram);
    return this.settings(actor);
  }
  async unlink(actor: Reviewer) {
    await this.current(actor);
    await this.store.unlink(actor.id);
    return this.settings(actor);
  }
  async pairing(actor: Reviewer) {
    await this.current(actor);
    this.enabled();
    const code = randomBytes(24).toString('base64url');
    await this.store.pairing(actor.id, tokenHash(code));
    return {
      url: `https://t.me/${this.config.TELEGRAM_BOT_USERNAME}?start=${code}`,
      expiresInSeconds: 600,
    };
  }
  private async pending(actor: Reviewer, id: string, version?: number) {
    const record = await this.approvals.get(id, actor.role);
    if (
      record.status !== 'pending' ||
      (version !== undefined && record.version !== version) ||
      record.reviews.some((r) => r.actorId === actor.id)
    )
      throw new NotificationConflict();
    const edit = record.reviews.find(
      (review) => review.action === 'edit',
    )?.message;
    return edit
      ? {
          ...record,
          proposedAction: { ...record.proposedAction, message: edit },
        }
      : record;
  }
  private async issue(
    actor: Reviewer,
    id: string,
    version: number,
    action: SignedDecision['action'],
  ) {
    const payload: SignedDecision = {
      v: 1,
      jti: randomUUID(),
      actorId: actor.id,
      approvalId: id,
      version,
      action,
      exp:
        Math.floor(this.now() / 1000) + this.config.APPROVAL_LINK_TTL_SECONDS,
    };
    const token = this.signer.sign(payload);
    await this.store.link(tokenHash(token), payload);
    return {
      token,
      payload,
      url: `${this.config.WEB_PUBLIC_URL}/approve#${token}`,
    };
  }
  async links(actor: Reviewer, id: string) {
    actor = await this.current(actor);
    const approval = await this.pending(actor, id);
    const approve = await this.issue(actor, id, approval.version, 'approve'),
      reject = await this.issue(actor, id, approval.version, 'reject');
    return {
      approve: approve.url,
      reject: reject.url,
      expiresAt: new Date(approve.payload.exp * 1000).toISOString(),
    };
  }
  async pendingFor(actor: Reviewer) {
    actor = await this.current(actor);
    return (await this.approvals.list(actor.role)).filter(
      (record) => !record.reviews.some((review) => review.actorId === actor.id),
    );
  }
  async channelDecisions(actor: Reviewer, id: string) {
    actor = await this.current(actor);
    const approval = await this.pending(actor, id);
    const approve = await this.issue(actor, id, approval.version, 'approve'),
      reject = await this.issue(actor, id, approval.version, 'reject');
    return {
      approval,
      approveId: approve.payload.jti,
      rejectId: reject.payload.jti,
      expiresAt: new Date(approve.payload.exp * 1000),
    };
  }
  async resolveChannel(
    actor: Reviewer,
    jti: string,
    channel: 'telegram' | 'whatsapp',
  ) {
    const payload = await this.store.payload(jti);
    if (!payload) throw new InvalidApprovalLink();
    return this.resolve(actor, this.signer.sign(payload), channel);
  }
  async inspect(actor: Reviewer, token: string) {
    actor = await this.current(actor);
    const payload = this.signer.verify(token);
    if (payload.actorId !== actor.id)
      throw new HttpError(
        403,
        'LINK_OWNER_MISMATCH',
        'This link belongs to a different reviewer',
      );
    await this.store.available(tokenHash(token), actor.id);
    return {
      action: payload.action,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
      approval: await this.pending(actor, payload.approvalId, payload.version),
    };
  }
  async resolve(
    actor: Reviewer,
    token: string,
    channel: 'web' | 'telegram' | 'whatsapp' = 'web',
  ) {
    actor = await this.current(actor);
    const payload = this.signer.verify(token);
    if (payload.actorId !== actor.id)
      throw new HttpError(
        403,
        'LINK_OWNER_MISMATCH',
        'This link belongs to a different reviewer',
      );
    await this.pending(actor, payload.approvalId, payload.version);
    const result = await this.store.consume(
      tokenHash(token),
      actor.id,
      (session) =>
        this.approvals.resolve(
          payload.approvalId,
          payload.version,
          payload.action === 'approve'
            ? { action: 'approve' }
            : {
                action: 'reject',
                reason: `Rejected through ${channel === 'telegram' ? 'Telegram' : channel === 'whatsapp' ? 'WhatsApp' : 'a signed approval link'}.`,
              },
          actor.id,
          actor.role,
          session,
        ),
    );
    await this.runs.reconcile().catch(() => {});
    return result;
  }
  webhookAllowed(secret: string | undefined) {
    this.enabled();
    const expected = Buffer.from(this.config.TELEGRAM_WEBHOOK_SECRET),
      actual = Buffer.from(secret ?? '');
    if (
      !expected.length ||
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    )
      throw new HttpError(
        403,
        'INVALID_WEBHOOK',
        'Invalid Telegram webhook secret',
      );
  }
  async webhook(raw: unknown) {
    this.enabled();
    const update = telegramUpdateSchema.parse(raw);
    const message = update.message;
    if (
      message?.text?.startsWith('/start ') &&
      message.from &&
      !message.from.is_bot &&
      message.chat.type === 'private' &&
      message.chat.id === message.from.id
    ) {
      const code = message.text.slice(7).trim();
      if (!/^[A-Za-z0-9_-]{32}$/.test(code)) return { ok: true };
      try {
        const owner = await this.store.pairingOwner(tokenHash(code));
        if (!owner) throw new NotificationConflict();
        await this.current({ id: owner, role: 'viewer' });
        await this.store.pair(
          tokenHash(code),
          String(message.from.id),
          String(message.chat.id),
        );
        await this.telegram.call('sendMessage', {
          chat_id: message.chat.id,
          text: 'Private chat linked. Approval notifications are enabled. Manage channels in Notification settings.',
        });
      } catch (error) {
        if (
          !(error instanceof NotificationConflict) &&
          !(error instanceof HttpError) &&
          (error as { code?: number }).code !== 11000
        )
          throw error;
      }
    }
    const callback = update.callback_query;
    if (callback) {
      let text = 'This approval link is unavailable. Open the web inbox.';
      try {
        const chat = callback.message?.chat;
        if (
          !chat ||
          chat.type !== 'private' ||
          chat.id !== callback.from.id ||
          callback.from.is_bot ||
          !/^decision:[0-9a-f-]{36}$/.test(callback.data ?? '')
        )
          throw new InvalidApprovalLink();
        const settings = await this.store.telegramIdentity(
          String(callback.from.id),
          String(chat.id),
        );
        if (!settings) throw new InvalidApprovalLink();
        const payload = await this.store.payload(callback.data!.slice(9));
        if (!payload || payload.actorId !== settings.userId)
          throw new InvalidApprovalLink();
        await this.resolve(
          { id: String(settings.userId), role: 'viewer' },
          this.signer.sign(payload),
          'telegram',
        );
        text =
          'Review recorded. Open the web inbox for the current approval state.';
      } catch (error) {
        if (!(
          error instanceof NotificationConflict ||
          error instanceof InvalidApprovalLink ||
          error instanceof HttpError
        ))
          throw error;
      }
      await this.telegram.call('answerCallbackQuery', {
        callback_query_id: callback.id,
        text,
        show_alert: true,
      });
    }
    return { ok: true };
  }
  async deliver() {
    if (this.config.TELEGRAM_ENABLED !== 'true' || this.delivering) return;
    this.delivering = true;
    try {
      const recipients = await this.store.recipients();
      for (const record of await this.approvals.list())
        for (const row of recipients) {
          let actor: Reviewer;
          try {
            actor = await this.current({
              id: String(row.userId),
              role: 'viewer',
            });
            await this.pending(actor, record.id, record.version);
          } catch (error) {
            if (
              error instanceof HttpError ||
              error instanceof NotificationConflict
            )
              continue;
            throw error;
          }
          const key = await this.store.claim(
            record.id,
            record.version,
            actor.id,
          );
          if (!key) continue;
          const approve = await this.issue(
              actor,
              record.id,
              record.version,
              'approve',
            ),
            reject = await this.issue(
              actor,
              record.id,
              record.version,
              'reject',
            );
          // Settings/role can change while a batch is being prepared; check again before transport.
          if (
            !(await this.store.telegramIdentity(
              String(row.telegramUserId),
              String(row.chatId),
            ))
          )
            continue;
          await this.current(actor);
          const current = await this.pending(actor, record.id, record.version);
          await this.telegram.call('sendMessage', {
            chat_id: row.chatId,
            text: `${current.title || 'Workflow approval'}\n${current.reasoning.slice(0, 1000)}\n\nDraft: ${String(current.proposedAction.message).slice(0, 500)}\nReviews: ${current.reviews.length}/${current.requiredApprovals}\nLinks expire in ${this.config.APPROVAL_LINK_TTL_SECONDS} seconds. Local demo effects only.`,
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: 'Approve',
                    callback_data: `decision:${approve.payload.jti}`,
                  },
                  {
                    text: 'Reject',
                    callback_data: `decision:${reject.payload.jti}`,
                  },
                ],
                [
                  {
                    text: 'Review / Edit',
                    url: `${this.config.WEB_PUBLIC_URL}/approvals#approval-${record.id}`,
                  },
                ],
              ],
            },
          });
          await this.store.delivered(key);
        }
    } finally {
      this.delivering = false;
    }
  }
}
