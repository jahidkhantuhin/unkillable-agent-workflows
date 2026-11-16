import type { RunDTO, RunEvent, WorkflowGraph } from '@unkillable/shared';
export type NodeStatus =
  | 'skipped'
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'waiting_approval'
  | 'retrying'
  | 'compensating'
  | 'compensated'
  | 'cancelled';
export type NodeView = {
  id: string;
  label: string;
  kind: string;
  status: NodeStatus;
  attempts: number;
  startedAt?: number;
  finishedAt?: number;
  input?: unknown;
  output?: unknown;
  events: RunEvent[];
  reviewer?: string;
  decision?: string;
};
export function mergeEvents(previous: RunEvent[], incoming: RunEvent[]) {
  return [
    ...new Map(
      [...previous, ...incoming].map((event) => [event.sequence, event]),
    ).values(),
  ].sort((a, b) => a.sequence - b.sequence);
}
export function advanceRun(run: RunDTO, event: RunEvent): RunDTO {
  if (event.sequence <= run.sequence) return run;
  const next = {
    ...run,
    sequence: event.sequence,
    updatedAt: new Date(event.timestamp).toISOString(),
  };
  if (event.type === 'STATE_SNAPSHOT') next.state = event.snapshot;
  if (event.type === 'RUN_STARTED') next.status = 'running';
  if (event.type === 'RUN_FINISHED') next.status = event.outcome;
  if (event.type === 'RUN_ERROR') {
    next.status = 'failed';
    next.error = event.message;
  }
  if (event.type === 'CUSTOM') {
    if (event.name === 'run.retried' || event.name === 'approval.resolved') {
      next.status = 'queued';
      next.execution = Number(event.value.execution ?? next.execution);
    }
    if (event.name === 'run.retried') next.error = undefined;
    if (event.name === 'approval.requested') next.status = 'waiting_approval';
    if (event.name === 'compensation.started') {
      next.status = 'compensating';
      if (typeof event.value.failure === 'string')
        next.error = event.value.failure;
    }
  }
  return next;
}
export const reverseActions: Record<string, string> = {
  publish: 'unpublish_content',
  reject: 'restore_moderation',
  notify: 'void_moderation_notice',
  close_ticket: 'reopen_ticket',
  send_email: 'send_correction_or_void',
  issue_refund: 'reverse_refund',
};
export function projectNodes(
  definition: WorkflowGraph,
  run: RunDTO,
  events: RunEvent[],
): NodeView[] {
  const rows = new Map<string, NodeView>(
    definition.nodes.map((node) => [
      node.id,
      { ...node, status: 'pending', attempts: 0, events: [] },
    ]),
  );
  const attempts = new Map<string, Set<string>>();
  let active: string | undefined;
  for (const event of mergeEvents([], events)) {
    let id =
      event.type === 'STEP_STARTED' || event.type === 'STEP_FINISHED'
        ? event.stepName
        : event.type === 'CUSTOM'
          ? String(
              event.value.nodeId ??
                (event.name.startsWith('approval.') ? 'approval' : ''),
            )
          : '';
    if (id === 'approval_after') id = 'approval';
    if (
      event.type === 'CUSTOM' &&
      event.name.startsWith('compensation.') &&
      id &&
      !rows.has(id)
    )
      rows.set(id, {
        id,
        label: id.replaceAll('_', ' '),
        kind: 'compensation',
        status: 'pending',
        attempts: 0,
        events: [],
      });
    const node = rows.get(id);
    if (node) {
      node.events.push(event);
      if (event.type === 'STEP_STARTED') {
        node.startedAt ??= event.timestamp;
        node.input = event.input ?? node.input;
        node.status = 'running';
        active = id;
      }
      if (event.type === 'STEP_FINISHED') {
        node.status = 'succeeded';
        node.finishedAt = event.timestamp;
        node.output = event.output;
      }
      if (event.type === 'CUSTOM') {
        if (event.name === 'node.attempt') {
          const seen = attempts.get(id) ?? new Set<string>();
          seen.add(
            `${event.value.execution}:${event.value.nodeId}:${event.value.attempt}`,
          );
          attempts.set(id, seen);
          node.attempts = seen.size;
          node.status = 'running';
          active = id;
        }
        if (event.name === 'retry.scheduled') node.status = 'retrying';
        if (event.name === 'approval.requested')
          node.status = 'waiting_approval';
        if (event.name === 'approval.resolved') {
          node.reviewer = String(event.value.actorId);
          const decision = event.value.decision as
            { action?: string } | undefined;
          node.decision = decision?.action;
          node.output = event.value;
          node.status = decision?.action === 'reject' ? 'cancelled' : 'running';
        }
        if (event.name === 'compensation.started') {
          node.attempts = Math.max(1, node.attempts);
          node.status = 'compensating';
          node.startedAt ??= event.timestamp;
          node.input = event.value.input;
        }
        if (event.name === 'compensation.finished') {
          node.status = 'compensated';
          node.finishedAt = event.timestamp;
          node.output = event.value;
        }
        if (event.name === 'compensation.failed') {
          node.status = 'failed';
          node.output = event.value;
        }
      }
    }
    if (event.type === 'RUN_ERROR' && active) {
      const failed = rows.get(active)!;
      failed.status = 'failed';
      failed.finishedAt = event.timestamp;
      failed.events.push(event);
    }
    if (
      event.type === 'CUSTOM' &&
      event.name === 'compensation.started' &&
      Array.isArray(event.value.plan)
    ) {
      if (active && rows.has(active)) {
        rows.get(active)!.status = 'failed';
        rows.get(active)!.finishedAt = event.timestamp;
      }
      for (const action of event.value.plan.map(String))
        if (!rows.has(action))
          rows.set(action, {
            id: action,
            label: action.replaceAll('_', ' '),
            kind: 'compensation',
            status: 'pending',
            attempts: 0,
            events: [],
          });
    }
  }
  const completed = Array.isArray(run.state.completed)
    ? run.state.completed.map(String)
    : [];
  for (const id of completed) {
    const node = rows.get(id);
    if (node && ['pending', 'running', 'retrying'].includes(node.status))
      node.status = 'succeeded';
  }
  const approval = rows.get('approval');
  if (
    run.workflowId === 'content-moderation' &&
    completed.includes('auto_decide')
  ) {
    if (run.state.decision === 'allow' && rows.has('reject'))
      rows.get('reject')!.status = 'skipped';
    if (run.state.decision === 'reject' && rows.has('publish'))
      rows.get('publish')!.status = 'skipped';
    if (
      approval &&
      run.state.decision !== 'review' &&
      !completed.includes('approval')
    )
      approval.status = 'skipped';
  }
  if (run.status === 'waiting_approval' && approval)
    approval.status = 'waiting_approval';
  if (run.status === 'cancelled' && approval) approval.status = 'cancelled';
  // Forward checkpoints remain historical; compensation is represented by separate nodes.
  const saga = run.state.saga as
    { plan?: string[]; completed?: string[] } | undefined;
  for (const id of saga?.plan ?? []) {
    if (!rows.has(id))
      rows.set(id, {
        id,
        label: id.replaceAll('_', ' '),
        kind: 'compensation',
        status: 'pending',
        attempts: 0,
        events: [],
      });
    if (saga?.completed?.includes(id)) rows.get(id)!.status = 'compensated';
  }
  return [...rows.values()];
}
export function elapsed(node: NodeView, now = Date.now()) {
  return node.startedAt === undefined
    ? null
    : Math.max(0, (node.finishedAt ?? now) - node.startedAt);
}
