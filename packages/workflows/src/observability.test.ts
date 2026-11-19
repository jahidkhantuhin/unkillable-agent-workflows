import { afterEach, expect, it, vi } from 'vitest';
import {
  observedRun,
  observedAttempt,
  recordModelUsage,
  observedApprovalWait,
  shutdownTracing,
} from './observability';
const sink = () => ({
  span: vi.fn(async (_value: unknown) => {}),
  usage: vi.fn(async (_value: unknown) => {}),
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await shutdownTracing();
});
it('keeps run/attempt attribution isolated and trace IDs stable across resumes', async () => {
  const store = sink();
  await Promise.all(
    ['run-a', 'run-b'].map((id) =>
      observedRun(id, 0, store, () =>
        observedAttempt('classify', 2, async () => {
          await recordModelUsage('mock', 'deterministic', {
            inputTokens: 0,
            outputTokens: 0,
          });
        }),
      ),
    ),
  );
  await observedRun('run-a', 1, store, () =>
    observedAttempt('send_email', 1, async () => {}),
  );
  const spans = store.span.mock.calls.map(
    ([v]) =>
      v as {
        runId: string;
        traceId: string;
        parentId?: string;
        nodeId: string;
      },
  );
  expect(
    new Set(spans.filter((v) => v.runId === 'run-a').map((v) => v.traceId))
      .size,
  ).toBe(1);
  expect(spans.find((v) => v.runId === 'run-a')!.traceId).not.toBe(
    spans.find((v) => v.runId === 'run-b')!.traceId,
  );
  expect(store.usage.mock.calls.map(([v]) => v)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        runId: 'run-a',
        nodeId: 'classify',
        attempt: 2,
        costUsd: 0,
      }),
      expect.objectContaining({ runId: 'run-b' }),
    ]),
  );
});
it('records failed attempts and never retries an operation for a telemetry storage failure', async () => {
  const store = sink();
  store.span.mockRejectedValue(new Error('DB unavailable'));
  const operation = vi.fn(async () => {
    throw new Error('business error');
  });
  await expect(
    observedRun('failed', 0, store, () =>
      observedAttempt('refund', 1, operation),
    ),
  ).rejects.toThrow('business error');
  expect(operation).toHaveBeenCalledTimes(1);
  expect(store.span).toHaveBeenCalledWith(
    expect.objectContaining({ nodeId: 'refund', status: 'error' }),
  );
});
it('records approval waiting and configured provider usage with unknowns preserved', async () => {
  vi.stubEnv(
    'LLM_PRICING_JSON',
    '{"test:model":{"inputPerMillion":1,"outputPerMillion":2}}',
  );
  const store = sink();
  await observedRun('usage', 1, store, async () => {
    await recordModelUsage('test', 'model', {
      inputTokens: 1000,
      outputTokens: 500,
    });
    await recordModelUsage('test', 'model', {});
    await observedApprovalWait('approval-a', new Date(1000), new Date(4000));
  });
  expect(store.usage).toHaveBeenCalledWith(
    expect.objectContaining({ costUsd: 0.002 }),
  );
  expect(store.usage).toHaveBeenCalledWith(
    expect.objectContaining({ costUsd: null, inputTokens: null }),
  );
  expect(store.span).toHaveBeenCalledWith(
    expect.objectContaining({ nodeId: 'approval.wait', durationMs: 3000 }),
  );
});
