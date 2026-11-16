'use client';
import { useEffect, useMemo, useState } from 'react';
import { useTheme } from 'next-themes';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  type Node,
  type NodeProps,
  type Edge,
} from '@xyflow/react';
import {
  workflowGraphSchema,
  type WorkflowGraph as Definition,
  type RunDTO,
  type RunEvent,
} from '@unkillable/shared';
import {
  projectNodes,
  reverseActions,
  elapsed,
  type NodeView,
  type NodeStatus,
} from '../lib/run-model';
import '@xyflow/react/dist/style.css';

const colors: Record<NodeStatus, string> = {
  pending: 'border-border text-muted-foreground',
  running: 'border-sky-500 text-sky-600 dark:text-sky-400',
  succeeded: 'border-emerald-500 text-emerald-700 dark:text-emerald-400',
  failed: 'border-red-500 text-red-600 dark:text-red-400',
  waiting_approval: 'border-amber-500 text-amber-700 dark:text-amber-400',
  retrying: 'border-violet-500 text-violet-600 dark:text-violet-400',
  compensating: 'border-orange-500 text-orange-700 dark:text-orange-400',
  compensated: 'border-teal-500 text-teal-700 dark:text-teal-400',
  cancelled: 'border-border text-muted-foreground',
};
export function NodeCard({
  node,
  onSelect,
}: {
  node: NodeView;
  onSelect?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={`graph-node-${node.id}`}
      data-status={node.status}
      aria-label={`${node.label}: ${node.status.replaceAll('_', ' ')}`}
      className={`w-48 rounded-xl border-2 bg-background px-4 py-3 text-left shadow-sm ${colors[node.status]} ${node.status === 'waiting_approval' ? 'approval-pulse' : ''}`}
    >
      <span className="block text-[10px] uppercase tracking-widest">
        {node.kind}
      </span>
      <span className="mt-1 block text-sm font-semibold capitalize">
        {node.label}
      </span>
      <span className="mt-2 block text-xs capitalize">
        {node.status.replaceAll('_', ' ')}
      </span>
    </button>
  );
}
type GraphNode = Node<{ view: NodeView; select: () => void }, 'workflow'>;
function FlowNode({ data }: NodeProps<GraphNode>) {
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <NodeCard node={data.view} onSelect={data.select} />
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}
const nodeTypes = { workflow: FlowNode };
function Json({ value }: { value: unknown }) {
  return (
    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">
      {value === undefined
        ? 'Not recorded for this node. Older runs may not include this data.'
        : JSON.stringify(value, null, 2)}
    </pre>
  );
}
export function WorkflowGraph({
  run,
  events,
}: {
  run: RunDTO;
  events: RunEvent[];
}) {
  const { resolvedTheme } = useTheme();
  const [definition, setDefinition] = useState<Definition | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string>('');
  const [now, setNow] = useState(Date.now());
  const [measurements, setMeasurements] = useState<
    Record<string, { width: number; height: number }>
  >({});
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/backend/runs/${run.id}/graph`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Definition unavailable');
        setDefinition(workflowGraphSchema.parse(await response.json()));
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError('Unable to load workflow definition. Refresh to retry.');
      });
    return () => controller.abort();
  }, [run.id]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const views = useMemo(
    () => (definition ? projectNodes(definition, run, events) : []),
    [definition, run, events],
  );
  const nodes: GraphNode[] = views.map((view, index) => ({
    id: view.id,
    type: 'workflow',
    measured: measurements[view.id],
    position: {
      x:
        view.kind === 'compensation'
          ? 720 - (index - definition!.nodes.length) * 240
          : (index % 4) * 240,
      y: view.kind === 'compensation' ? 360 : Math.floor(index / 4) * 160,
    },
    data: { view, select: () => setSelected(view.id) },
  }));
  const edges: Edge[] = (definition?.edges ?? []).map((edge) => ({
    id: `${edge.source}-${edge.target}`,
    source: edge.source,
    target: edge.target,
    type: 'smoothstep',
    markerEnd: { type: MarkerType.ArrowClosed },
    animated: ['running', 'retrying', 'waiting_approval'].includes(
      views.find((node) => node.id === edge.target)?.status ?? '',
    ),
    style: { stroke: '#64748b', strokeWidth: 2 },
  }));
  const compensations = views.filter((node) => node.kind === 'compensation');
  for (const [index, node] of compensations.entries()) {
    const source = index
      ? compensations[index - 1].id
      : Object.entries(reverseActions).find(
          ([, action]) => action === node.id,
        )?.[0];
    if (source)
      edges.push({
        id: `undo-${node.id}`,
        source,
        target: node.id,
        type: 'smoothstep',
        label: 'compensate',
        animated: run.status === 'compensating',
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: '#f97316', strokeWidth: 2, strokeDasharray: '6 4' },
      });
  }
  const inspected = views.find((node) => node.id === selected);
  return (
    <section
      className="mt-8 rounded-2xl border border-border p-4 md:p-6"
      aria-label="Live workflow graph"
    >
      <div className="flex flex-wrap justify-between gap-3">
        <h2 className="font-medium">Live workflow graph</h2>
        <p className="text-xs text-muted-foreground">
          Select a node to inspect its work
        </p>
      </div>
      <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
        {[
          'pending',
          'running',
          'succeeded',
          'failed',
          'waiting approval',
          'retrying',
          'compensating',
          'compensated',
        ].map((status) => (
          <span key={status}>{status}</span>
        ))}
      </div>
      {error ? (
        <p role="alert" className="mt-4 text-sm text-red-500">
          {error}
        </p>
      ) : !definition ? (
        <p className="mt-4 text-sm">Loading definition…</p>
      ) : (
        <>
          <div className="mt-4 h-[420px] overflow-hidden rounded-xl border border-border bg-muted/20 md:h-[500px]">
            <ReactFlow
              colorMode={resolvedTheme === 'dark' ? 'dark' : 'light'}
              nodes={nodes}
              onNodesChange={(changes) => {
                const dimensions = changes.filter(
                  (change) => change.type === 'dimensions',
                );
                if (!dimensions.length) return;
                setMeasurements((previous) => {
                  let next = previous;
                  for (const change of dimensions) {
                    if (!change.dimensions) continue;
                    const old = previous[change.id];
                    if (
                      old?.width === change.dimensions.width &&
                      old?.height === change.dimensions.height
                    )
                      continue;
                    if (next === previous) next = { ...previous };
                    next[change.id] = change.dimensions;
                  }
                  return next;
                });
              }}
              edges={edges}
              nodeTypes={nodeTypes}
              nodesDraggable={false}
              nodesConnectable={false}
              deleteKeyCode={null}
              fitView
              fitViewOptions={{ padding: 0.18 }}
              minZoom={0.3}
              maxZoom={1.5}
              aria-label="Workflow execution"
            >
              <Background color="#64748b" gap={24} />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
          {inspected && (
            <section
              className="mt-5 rounded-xl border border-border p-4"
              aria-label="Node inspector"
            >
              <h3 className="font-semibold capitalize">{inspected.label}</h3>
              <p className="mt-2 text-sm">
                {inspected.status.replaceAll('_', ' ')} · {inspected.attempts}{' '}
                recorded attempts ·{' '}
                {elapsed(inspected, now) === null
                  ? 'Duration not recorded'
                  : `${(elapsed(inspected, now)! / 1000).toFixed(1)}s elapsed`}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Elapsed time includes retries, downtime and human review where
                applicable.
              </p>
              {inspected.reviewer && (
                <p className="mt-2 text-xs">
                  Reviewer: {inspected.reviewer} · Decision:{' '}
                  {inspected.decision}
                </p>
              )}
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div>
                  <h4 className="text-sm font-medium">Input</h4>
                  <Json value={inspected.input} />
                </div>
                <div>
                  <h4 className="text-sm font-medium">Output</h4>
                  <Json value={inspected.output} />
                </div>
              </div>
            </section>
          )}
          <div className="mt-6 space-y-3" aria-label="Timeline grouped by node">
            <h3 className="text-sm font-semibold">Node timeline</h3>
            {views.map((node) => (
              <details
                key={node.id}
                className="rounded-xl border border-border p-4"
              >
                <summary className="cursor-pointer text-sm capitalize">
                  {node.label} · {node.status.replaceAll('_', ' ')} ·{' '}
                  {node.attempts} attempts ·{' '}
                  {elapsed(node, now) === null
                    ? 'not started'
                    : `${(elapsed(node, now)! / 1000).toFixed(1)}s`}
                </summary>
                {node.reviewer && (
                  <p className="mt-3 text-xs">
                    Reviewer: {node.reviewer} · {node.decision}
                  </p>
                )}
                <ol className="mt-3 space-y-2">
                  {node.events.map((event) => (
                    <li key={event.sequence} className="text-xs">
                      #{event.sequence} ·{' '}
                      {event.type === 'CUSTOM'
                        ? event.name
                        : event.type.toLowerCase().replaceAll('_', ' ')}
                      {event.type === 'CUSTOM' &&
                      event.name === 'retry.scheduled'
                        ? ` · retry ${String(event.value.nextAttempt)} in ${String(event.value.delayMs)} ms`
                        : ''}{' '}
                      · {new Date(event.timestamp).toLocaleTimeString()}
                    </li>
                  ))}
                </ol>
              </details>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
