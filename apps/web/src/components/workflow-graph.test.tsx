import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { NodeCard } from './workflow-graph';
import type { NodeStatus } from '../lib/run-model';
describe('workflow node visuals', () => {
  it.each<NodeStatus>([
    'pending',
    'running',
    'succeeded',
    'failed',
    'waiting_approval',
    'retrying',
    'compensating',
    'compensated',
  ])('renders accessible %s state', (status) => {
    const html = renderToString(
      createElement(NodeCard, {
        node: {
          id: 'approval',
          label: 'Human review',
          kind: 'approval',
          status,
          attempts: 0,
          events: [],
        },
      }),
    );
    expect(html).toContain(`data-status="${status}"`);
    expect(html).toContain(
      `aria-label="Human review: ${status.replaceAll('_', ' ')}"`,
    );
    expect(html.includes('approval-pulse')).toBe(status === 'waiting_approval');
  });
});
