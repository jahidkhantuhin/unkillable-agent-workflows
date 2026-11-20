import { expect, it } from 'vitest';
import { approvalDTOSchema } from '@unkillable/shared';
import {
  actionableApprovals,
  approvalAlertStage,
  approvalAlertKey,
} from './approval-alerts';
const now = Date.parse('2026-01-01T00:00:00Z');
function approval() {
  return approvalDTOSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    runId: '22222222-2222-4222-8222-222222222222',
    nodeId: 'approval',
    title: 'Local notice',
    status: 'pending',
    version: 0,
    proposedAction: { kind: 'notice', message: 'Synthetic' },
    reasoning: 'Human review',
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    sla: {
      remindAt: new Date(now + 1000).toISOString(),
      escalateAt: new Date(now + 2000).toISOString(),
      expireAt: new Date(now + 3000).toISOString(),
      escalateRole: 'admin',
      timeoutAction: 'reject',
    },
  });
}
it('counts only live pending requests the current reviewer may still act on', () => {
  const a = approval();
  expect(actionableApprovals([a], 'reviewer', 'admin', now)).toHaveLength(1);
  expect(actionableApprovals([a], 'reviewer', 'viewer', now)).toEqual([]);
  expect(actionableApprovals([a], 'reviewer', 'admin', now + 3000)).toEqual([]);
  expect(
    actionableApprovals(
      [{ ...a, status: 'approved' }],
      'reviewer',
      'admin',
      now,
    ),
  ).toEqual([]);
  expect(
    actionableApprovals(
      [
        {
          ...a,
          reviews: [
            {
              actorId: 'reviewer',
              action: 'approve',
              at: new Date(now).toISOString(),
            },
          ],
        },
      ],
      'reviewer',
      'admin',
      now,
    ),
  ).toEqual([]);
  expect(
    actionableApprovals(
      [{ ...a, proposedAction: { kind: 'moderation' } }],
      'reviewer',
      'approver',
      now,
    ),
  ).toEqual([]);
});
it('targets escalation attention to its group and creates a stable key for unchanged polls', () => {
  const a = approval(),
    key = approvalAlertKey(a, 'admin');
  expect(approvalAlertKey({ ...a }, 'admin')).toBe(key);
  const reminded = {
    ...a,
    sla: { ...a.sla!, remindedAt: new Date(now).toISOString() },
  };
  expect(approvalAlertKey(reminded, 'admin')).not.toBe(key);
  const escalated = {
    ...reminded,
    sla: { ...reminded.sla!, escalatedAt: new Date(now).toISOString() },
  };
  expect(approvalAlertStage(escalated, 'admin')).toBe('escalated');
  expect(approvalAlertStage(escalated, 'approver')).toBe('reminder');
  expect(approvalAlertKey(escalated, 'approver')).toBe(
    approvalAlertKey(reminded, 'approver'),
  );
});
