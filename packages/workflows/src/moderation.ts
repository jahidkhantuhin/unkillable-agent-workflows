import {
  moderationCheckSchema,
  modelPreviewChars,
  type ModerationState,
} from '@unkillable/shared';
export interface ModerationLLM {
  check(text: string): Promise<unknown>;
}
export class MockModerationLLM implements ModerationLLM {
  async check(text: string) {
    return {
      verdict: text.includes('DEMO_BLOCK')
        ? 'reject'
        : text.includes('DEMO_REVIEW')
          ? 'review'
          : 'allow',
      confidence: 0.98,
      reason: 'Deterministic MockLLM check of synthetic content.',
    };
  }
}
export async function checkModeration(text: string, llm: ModerationLLM) {
  const check = moderationCheckSchema.parse(
    await llm.check(text.slice(0, modelPreviewChars)),
  );
  // Rules inspect the whole bounded file, including text outside the model preview.
  const hardBlock = text.includes('DEMO_BLOCK');
  const review =
    text.includes('DEMO_REVIEW') ||
    text.length > modelPreviewChars ||
    check.confidence < 0.9 ||
    check.verdict === 'review' ||
    (text.match(/https?:\/\//g)?.length ?? 0) > 5;
  const decision =
    hardBlock || check.verdict === 'reject'
      ? ('reject' as const)
      : review
        ? ('review' as const)
        : ('allow' as const);
  return {
    check,
    decision,
    preview: text.slice(0, 2000),
    decisionReason: hardBlock
      ? 'Full-file rule found DEMO_BLOCK; reject without publication.'
      : text.length > modelPreviewChars && decision === 'review'
        ? 'File exceeds the model preview; an administrator must review the full content.'
        : review
          ? 'Rule, confidence or model result requires administrator review.'
          : check.reason,
  };
}
export type ModerationOperations = {
  check(state: ModerationState): Promise<Partial<ModerationState>>;
  decide(state: ModerationState, publish: boolean): Promise<void>;
  notify(state: ModerationState): Promise<void>;
};
