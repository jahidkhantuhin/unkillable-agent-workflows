import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import {
  context,
  trace,
  ROOT_CONTEXT,
  SpanStatusCode,
  type Span,
} from '@opentelemetry/api';
import {
  NodeTracerProvider,
  BatchSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { observabilityConfigSchema, usageCost } from '@unkillable/shared';
interface Sink {
  span(value: unknown): Promise<void>;
  usage(value: unknown): Promise<void>;
}
type Scope = {
  runId: string;
  execution: number;
  sink: Sink;
  nodeId: string;
  attempt: number;
  parent?: Span;
};
const scope = new AsyncLocalStorage<Scope>();
let provider: NodeTracerProvider | undefined;
function tracer() {
  if (!provider) {
    const config = observabilityConfigSchema.parse(process.env);
    provider = new NodeTracerProvider({
      idGenerator: {
        generateTraceId: () =>
          scope.getStore()
            ? createHash('sha256')
                .update(`unkillable-trace:${scope.getStore()!.runId}`)
                .digest('hex')
                .slice(0, 32)
            : randomBytes(16).toString('hex'),
        generateSpanId: () => randomBytes(8).toString('hex'),
      },
      spanProcessors: config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
        ? [
            new BatchSpanProcessor(
              new OTLPTraceExporter({
                url: config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
                timeoutMillis: 3000,
              }),
            ),
          ]
        : [],
    });
  }
  return provider.getTracer('unkillable-workflows');
}
// Observability failures must never repeat a business operation.
async function persist(operation: () => Promise<void>) {
  try {
    await operation();
  } catch {
    /* A killed process or unavailable DB can leave incomplete telemetry, never a false success. */
  }
}
export async function observedAttempt<T>(
  nodeId: string,
  attempt: number,
  operation: () => Promise<T>,
): Promise<T> {
  const current = scope.getStore();
  if (!current) return operation();
  const startedAt = new Date(),
    parent = current.parent,
    span = tracer().startSpan(
      nodeId,
      {
        attributes: {
          'run.id': current.runId,
          'run.execution': current.execution,
          'node.id': nodeId,
          'node.attempt': attempt,
        },
      },
      parent ? trace.setSpan(ROOT_CONTEXT, parent) : context.active(),
    );
  let status: 'ok' | 'error' = 'ok';
  try {
    return await scope.run(
      { ...current, nodeId, attempt, parent: span },
      operation,
    );
  } catch (error) {
    status = 'error';
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
    const ids = span.spanContext();
    await persist(() =>
      current.sink.span({
        id: ids.spanId,
        traceId: ids.traceId,
        parentId: parent?.spanContext().spanId,
        runId: current.runId,
        execution: current.execution,
        nodeId,
        attempt,
        startedAt,
        durationMs: Math.max(0, Date.now() - +startedAt),
        status,
      }),
    );
  }
}
export function observedRun<T>(
  runId: string,
  execution: number,
  sink: Sink,
  operation: () => Promise<T>,
) {
  return scope.run({ runId, execution, sink, nodeId: 'run', attempt: 0 }, () =>
    observedAttempt('run', 0, operation),
  );
}
export async function recordModelUsage(
  providerName: string,
  model: string,
  usage: { inputTokens?: number; outputTokens?: number },
) {
  const current = scope.getStore();
  if (!current) return;
  const inputTokens = usage.inputTokens ?? null,
    outputTokens = usage.outputTokens ?? null,
    prices = observabilityConfigSchema.parse(process.env).LLM_PRICING_JSON;
  await persist(() =>
    current.sink.usage({
      id: randomUUID(),
      runId: current.runId,
      execution: current.execution,
      nodeId: current.nodeId,
      attempt: current.attempt,
      provider: providerName,
      model,
      inputTokens,
      outputTokens,
      costUsd:
        providerName === 'mock'
          ? 0
          : usageCost(
              inputTokens,
              outputTokens,
              prices[`${providerName}:${model}`],
            ),
      at: new Date(),
    }),
  );
}
export async function shutdownTracing() {
  await provider?.shutdown();
  provider = undefined;
}
export async function observedApprovalWait(
  approvalId: string,
  startedAt: Date,
  endedAt: Date,
) {
  const current = scope.getStore();
  if (!current) return;
  const parent = current.parent,
    span = tracer().startSpan(
      'approval.wait',
      {
        startTime: startedAt,
        attributes: {
          'run.id': current.runId,
          'run.execution': current.execution,
          'approval.wait_ms': Math.max(0, +endedAt - +startedAt),
        },
      },
      parent ? trace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT,
    );
  span.end(endedAt);
  const ids = span.spanContext();
  await persist(() =>
    current.sink.span({
      id: `approval-wait-${approvalId}`,
      traceId: ids.traceId,
      parentId: parent?.spanContext().spanId,
      runId: current.runId,
      execution: current.execution,
      nodeId: 'approval.wait',
      attempt: 0,
      startedAt,
      durationMs: Math.max(0, +endedAt - +startedAt),
      status: 'ok',
    }),
  );
}
