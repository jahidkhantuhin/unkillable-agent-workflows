import { randomUUID } from 'node:crypto';
import {
  demoStateSchema,
  supportStateSchema,
  moderationStateSchema,
  demoForkEditsSchema,
  supportForkEditsSchema,
  moderationForkEditsSchema,
} from '@unkillable/shared';
export class ForkStateError extends Error {}
/** Carry over pure results only; fresh business IDs/approval/effect state belong to the child. */
export function prepareForkState(
  workflow: string,
  raw: unknown,
  edits: Record<string, unknown>,
) {
  if (workflow === 'durability-demo') {
    const source = demoStateSchema.parse(raw),
      patch = demoForkEditsSchema.parse(edits);
    const changed =
      patch.message !== undefined && patch.message !== source.message;
    const completed = changed
      ? []
      : (['prepare', 'summarize'] as const).filter((node) =>
          source.completed.includes(node),
        );
    const state = demoStateSchema.parse({
      ...source,
      ...patch,
      normalized: changed ? '' : source.normalized,
      summary: changed ? '' : source.summary,
      completed,
      result: '',
      noticeMessage: '',
      approvalAction: 'pending',
    });
    return { state, asNode: completed.at(-1) ?? '__start__' };
  }
  if (workflow === 'support-ticket-router') {
    const source = supportStateSchema.parse(raw),
      patch = supportForkEditsSchema.parse(edits);
    const completed = (
      ['classify', 'retrieve_policy', 'draft_reply'] as const
    ).filter((node) => source.completed.includes(node));
    if (patch.draftMessage !== undefined && !completed.includes('draft_reply'))
      throw new ForkStateError(
        'Choose a checkpoint after draft_reply before editing its reply.',
      );
    const state = supportStateSchema.parse({
      title: patch.title ?? source.title,
      message: source.message,
      ticketId: randomUUID(),
      ticket: source.ticket,
      ...(completed.includes('classify')
        ? { classification: source.classification }
        : {}),
      ...(completed.includes('retrieve_policy')
        ? { policies: source.policies }
        : {}),
      ...(completed.includes('draft_reply')
        ? {
            draft: {
              ...source.draft,
              message:
                patch.draftMessage ??
                (source.approvedMessage || source.draft.message),
            },
          }
        : {}),
      completed,
    });
    return { state, asNode: completed.at(-1) ?? '__start__' };
  }
  if (workflow === 'content-moderation') {
    const source = moderationStateSchema.parse(raw),
      patch = moderationForkEditsSchema.parse(edits);
    const completed = source.completed.includes('upload')
      ? ['upload' as const]
      : [];
    const state = moderationStateSchema.parse({
      title: patch.title ?? source.title,
      contentId: randomUUID(),
      file: source.file,
      completed,
    });
    return { state, asNode: completed.at(-1) ?? '__start__' };
  }
  throw new ForkStateError('Forking is unavailable for this workflow.');
}
