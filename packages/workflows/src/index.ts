import { demoWorkflowVersion } from '@unkillable/shared';
export const demoDefinition = {
  id: 'durability-demo',
  name: 'Durability demo',
  version: demoWorkflowVersion,
  createdAt: new Date('2026-11-14T00:00:00.000Z'),
  updatedAt: new Date('2026-11-14T00:00:00.000Z'),
  nodes: [
    { id: 'prepare', label: 'Prepare input', kind: 'task' },
    { id: 'summarize', label: 'Summarize', kind: 'task' },
    {
      id: 'approval',
      label: 'Review local notice (optional)',
      kind: 'approval',
    },
    {
      id: 'complete',
      label: 'Complete and queue local notice',
      kind: 'effect',
    },
  ],
  edges: [
    { source: 'prepare', target: 'summarize' },
    { source: 'summarize', target: 'complete' },
    { source: 'summarize', target: 'approval' },
    { source: 'approval', target: 'complete' },
  ],
} as const;
