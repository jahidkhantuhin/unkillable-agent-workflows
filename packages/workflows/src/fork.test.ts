import { it, expect } from 'vitest';
import { prepareForkState } from './fork';
import {
  demoStateSchema,
  moderationStateSchema,
  supportStateSchema,
  supportExamples,
} from '@unkillable/shared';
it('rewinds edited demo inputs and never copies delivery or approval results', () => {
  const source = demoStateSchema.parse({
    title: 'Parent',
    message: 'Old notice',
    normalized: 'Old notice',
    summary: '2 words',
    completed: ['prepare', 'summarize', 'approval', 'complete'],
    approvalAction: 'approve',
    noticeMessage: 'Old notice',
    result: 'Done',
  });
  const child = prepareForkState('durability-demo', source, {
    message: 'New notice',
  });
  expect(child.asNode).toBe('__start__');
  expect(child.state.completed).toEqual([]);
  expect(child.state.approvalAction).toBe('pending');
  expect(demoStateSchema.parse(child.state).result).toBe('');
  expect(prepareForkState('durability-demo', source, {}).asNode).toBe(
    'summarize',
  );
  expect(() =>
    prepareForkState('durability-demo', source, { completed: [] }),
  ).toThrow();
  expect(source.completed).toHaveLength(4);
});
it('gives support forks new business IDs and removes approved effect state', () => {
  const source = supportStateSchema.parse({
    title: 'Parent',
    message: 'Duplicate charge',
    ticketId: 'parent-ticket',
    ticket: Object.fromEntries(
      Object.entries(supportExamples[0]).filter(([key]) => key !== 'id'),
    ),
    completed: [
      'classify',
      'retrieve_policy',
      'draft_reply',
      'risk_check',
      'approval',
      'issue_refund',
      'send_email',
      'close_ticket',
    ],
    approvedMessage: 'Human reply',
    approvalAction: 'approve',
  });
  const child = prepareForkState('support-ticket-router', source, {
    draftMessage: 'Kinder reply',
  });
  expect(child.asNode).toBe('draft_reply');
  expect(supportStateSchema.parse(child.state).ticketId).not.toBe(
    source.ticketId,
  );
  expect(child.state.approvalAction).toBe('pending');
  expect(supportStateSchema.parse(child.state).approvedMessage).toBe('');
  expect(supportStateSchema.parse(child.state).draft.message).toBe(
    'Kinder reply',
  );
  expect(supportStateSchema.parse(child.state).refund.id).toBe('');
  expect(() =>
    prepareForkState(
      'support-ticket-router',
      { ...source, completed: [] },
      { draftMessage: 'too early' },
    ),
  ).toThrow('after draft_reply');
  expect(() =>
    prepareForkState('support-ticket-router', source, { ticketId: 'stolen' }),
  ).toThrow();
});
it('moderation forks reuse immutable input but rerun screening and human review', () => {
  const source = moderationStateSchema.parse({
    title: 'Parent',
    contentId: '00000000-0000-4000-8000-000000000001',
    file: {
      key: '00000000-0000-4000-8000-000000000000.txt',
      bytes: 5,
      sha256: 'a'.repeat(64),
    },
    completed: [
      'upload',
      'automated_check',
      'auto_decide',
      'approval',
      'publish',
      'notify',
    ],
    decision: 'allow',
  });
  const child = prepareForkState('content-moderation', source, {
    title: 'Child',
  });
  expect(child.asNode).toBe('upload');
  expect(moderationStateSchema.parse(child.state).contentId).not.toBe(
    source.contentId,
  );
  expect(moderationStateSchema.parse(child.state).file).toEqual(source.file);
  expect(child.state.completed).toEqual(['upload']);
  expect(moderationStateSchema.parse(child.state).decision).toBe('pending');
});
