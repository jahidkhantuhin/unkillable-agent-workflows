import { describe, it, expect } from 'vitest';
import {
  runDTOSchema,
  runEventSchema,
  type RunEvent,
  type EventInput,
  type WorkflowGraph,
} from '@unkillable/shared';
import { projectNodes, advanceRun, mergeEvents, elapsed } from './run-model';
export const graph: WorkflowGraph = {
  id: 'support-ticket-router',
  name: 'Support',
  version: 1,
  nodes: [
    { id: 'classify', label: 'Classify', kind: 'task' },
    { id: 'approval', label: 'Approval', kind: 'approval' },
    { id: 'close_ticket', label: 'Close ticket', kind: 'effect' },
  ],
  edges: [],
};
export const run = runDTOSchema.parse({
  id: 'run',
  workflowId: graph.id,
  workflowVersion: 1,
  createdBy: 'test',
  status: 'running',
  state: {},
  sequence: 0,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
});
export function event(sequence: number, input: EventInput): RunEvent {
  return runEventSchema.parse({
    ...input,
    id: `e${sequence}`,
    runId: 'run',
    threadId: 'run',
    sequence,
    timestamp: sequence * 1000,
  });
}
describe('event-derived workflow state', () => {
  it('orders and deduplicates replay and ignores older events for the canonical run', () => {
    const first = event(1, { type: 'RUN_STARTED' }),
      second = event(2, { type: 'RUN_FINISHED', outcome: 'succeeded' });
    expect(
      mergeEvents([second], [first, second]).map((e) => e.sequence),
    ).toEqual([1, 2]);
    const latest = advanceRun(run, second);
    expect(advanceRun(latest, first)).toEqual(latest);
  });
  it('maps attempts, retry markers, input/output and wall-clock duration', () => {
    const history = [
      event(1, {
        type: 'STEP_STARTED',
        stepName: 'classify',
        input: { ticket: 'incoming' },
      }),
      event(2, {
        type: 'CUSTOM',
        name: 'node.attempt',
        value: { nodeId: 'classify', execution: 0, attempt: 1 },
      }),
      event(3, {
        type: 'CUSTOM',
        name: 'retry.scheduled',
        value: { nodeId: 'classify', nextAttempt: 2 },
      }),
    ];
    expect(projectNodes(graph, run, history)[0].status).toBe('retrying');
    history.push(
      event(4, {
        type: 'CUSTOM',
        name: 'node.attempt',
        value: { nodeId: 'classify', execution: 0, attempt: 2 },
      }),
      event(5, {
        type: 'STEP_FINISHED',
        stepName: 'classify',
        output: { classification: 'duplicate' },
      }),
    );
    const node = projectNodes(graph, run, history)[0];
    expect(node.attempts).toBe(2);
    expect(node.input).toEqual({ ticket: 'incoming' });
    expect(node.output).toEqual({ classification: 'duplicate' });
    expect(elapsed(node, 9000)).toBe(4000);
    expect(node.status).toBe('succeeded');
  });
  it('rebuilds approval and reviewer after a complete replay without guessing missing historical payloads', () => {
    const waiting = { ...run, status: 'waiting_approval' as const };
    expect(projectNodes(graph, waiting, [])[1].status).toBe('waiting_approval');
    const node = projectNodes(graph, run, [
      event(1, {
        type: 'CUSTOM',
        name: 'approval.resolved',
        value: { actorId: 'reviewer-1', decision: { action: 'edit' } },
      }),
    ])[1];
    expect(node.reviewer).toBe('reviewer-1');
    expect(node.decision).toBe('edit');
    expect(node.input).toBeUndefined();
  });
  it('preserves failed forward nodes while adding ordered compensation progress', () => {
    const history = [
      event(1, { type: 'STEP_STARTED', stepName: 'close_ticket' }),
      event(2, {
        type: 'CUSTOM',
        name: 'compensation.started',
        value: { plan: ['reopen_ticket', 'reverse_refund'] },
      }),
      event(3, {
        type: 'CUSTOM',
        name: 'compensation.started',
        value: { nodeId: 'reopen_ticket' },
      }),
      event(4, {
        type: 'CUSTOM',
        name: 'compensation.finished',
        value: { nodeId: 'reopen_ticket' },
      }),
    ];
    const nodes = projectNodes(
      graph,
      { ...run, status: 'compensating' },
      history,
    );
    expect(nodes.find((n) => n.id === 'close_ticket')?.status).toBe('failed');
    expect(nodes.find((n) => n.id === 'reopen_ticket')?.status).toBe(
      'compensated',
    );
    expect(nodes.find((n) => n.id === 'reverse_refund')?.status).toBe(
      'pending',
    );
  });
});
