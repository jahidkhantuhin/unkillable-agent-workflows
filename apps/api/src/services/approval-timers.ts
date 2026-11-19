import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { OperationsRepository } from '@unkillable/storage';
import { slaJobSchema } from '@unkillable/shared';
export function startApprovalTimers(
  store: OperationsRepository,
  connection: Redis,
  namespace: string,
  onError: (error: unknown) => void,
) {
  const name = `${namespace}-approval-sla`,
    queue = new Queue(name, { connection });
  queue.on('error', onError);
  const worker = new Worker(
    name,
    async (job) => {
      await store.timer(slaJobSchema.parse(job.data));
    },
    { connection, concurrency: 2 },
  );
  worker.on('error', onError);
  worker.on('failed', (_job, error) => onError(error));
  let active = false;
  async function reconcile() {
    if (active) return;
    active = true;
    try {
      for (const approval of await store.scheduled()) {
        const sla = approval.sla!;
        for (const [stage, due] of [
          ['remind', sla.remindAt],
          ['escalate', sla.escalateAt],
          ['expire', sla.expireAt],
        ] as const) {
          const marked =
            stage === 'remind'
              ? sla.remindedAt
              : stage === 'escalate'
                ? sla.escalatedAt
                : sla.expiredAt;
          if (marked) continue;
          await queue.add(
            stage,
            { approvalId: approval.id, stage },
            {
              jobId: `${approval.id}-${stage}`,
              delay: Math.max(0, +due - Date.now()),
              attempts: 5,
              backoff: { type: 'exponential', delay: 1000 },
              removeOnComplete: 10000,
              removeOnFail: 10000,
            },
          );
        }
      }
    } finally {
      active = false;
    }
  }
  const timer = setInterval(() => {
    void reconcile().catch(onError);
  }, 1000).unref();
  return {
    queue,
    reconcile,
    async close() {
      clearInterval(timer);
      await worker.close();
      await queue.close();
      connection.disconnect();
    },
  };
}
