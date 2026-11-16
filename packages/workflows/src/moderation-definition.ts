import { moderationWorkflowId, moderationNodeSchema } from '@unkillable/shared';
export const moderationDefinition = {
  id: moderationWorkflowId,
  name: 'Async content moderation',
  version: 1,
  createdAt: new Date('2026-11-16T00:00:00Z'),
  updatedAt: new Date('2026-11-16T00:00:00Z'),
  nodes: moderationNodeSchema.options.map((id) => ({
    id,
    label: id === 'approval' ? 'Admin review' : id.replaceAll('_', ' '),
    kind:
      id === 'approval'
        ? ('approval' as const)
        : ['publish', 'reject', 'notify'].includes(id)
          ? ('effect' as const)
          : ('task' as const),
  })),
  edges: [
    ['upload', 'automated_check'],
    ['automated_check', 'auto_decide'],
    ['auto_decide', 'approval'],
    ['auto_decide', 'publish'],
    ['auto_decide', 'reject'],
    ['approval', 'publish'],
    ['approval', 'reject'],
    ['publish', 'notify'],
    ['reject', 'notify'],
  ].map(([source, target]) => ({ source, target })),
};
