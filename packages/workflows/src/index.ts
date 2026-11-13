export const demoDefinition = {
  id: 'durability-demo',
  name: 'Durability demo',
  version: 1,
  createdAt: new Date('2026-11-14T00:00:00.000Z'),
  updatedAt: new Date('2026-11-14T00:00:00.000Z'),
  nodes: [
    { id: 'prepare', label: 'Prepare input', kind: 'task' },
    { id: 'summarize', label: 'Summarize', kind: 'task' },
    { id: 'complete', label: 'Complete', kind: 'task' },
  ],
  edges: [
    { source: 'prepare', target: 'summarize' },
    { source: 'summarize', target: 'complete' },
  ],
} as const;
