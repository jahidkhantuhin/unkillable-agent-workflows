import { supportWorkflowId, supportNodeSchema } from '@unkillable/shared';
export const supportDefinition = {
  id: supportWorkflowId,
  name: 'Support ticket router',
  version: 1,
  createdAt: new Date('2026-11-15T00:00:00.000Z'),
  updatedAt: new Date('2026-11-15T00:00:00.000Z'),
  nodes: supportNodeSchema.options.map((id) => ({
    id,
    label: id.replaceAll('_', ' '),
    kind:
      id === 'approval'
        ? ('approval' as const)
        : ['issue_refund', 'send_email', 'close_ticket'].includes(id)
          ? ('effect' as const)
          : ('task' as const),
  })),
  edges: supportNodeSchema.options.slice(1).map((id, index) => ({
    source: supportNodeSchema.options[index],
    target: id,
  })),
};
