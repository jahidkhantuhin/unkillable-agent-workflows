import { observedAttempt } from './observability';
import {
  defaultRetryPolicy,
  retryDelay,
  classifyError,
  NodeFailure,
  type AttemptStore,
  type RetryPolicy,
} from '@unkillable/shared';
export async function retryOperation<T>(
  nodeId: string,
  operation: (attempt: number) => Promise<T>,
  store: AttemptStore,
  policy: RetryPolicy = defaultRetryPolicy,
  clock = {
    now: () => new Date(),
    sleep: (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
    random: Math.random,
  },
): Promise<T> {
  while (true) {
    const previous = await store.load();
    if (previous?.status === 'failed' && previous.error)
      throw new NodeFailure(nodeId, previous.attempt, previous.error);
    if (previous?.status === 'retrying' && previous.nextAttemptAt)
      await clock.sleep(
        Math.max(0, previous.nextAttemptAt.getTime() - clock.now().getTime()),
      );
    const current = await store.start(previous?.policy ?? policy);
    try {
      const result = await observedAttempt(nodeId, current.attempt, () =>
        operation(current.attempt),
      );
      await store.succeed();
      return result;
    } catch (error) {
      const info = classifyError(error);
      if (
        info.classification === 'permanent' ||
        current.attempt >= current.policy.maxAttempts
      ) {
        await store.fail(info);
        throw new NodeFailure(nodeId, current.attempt, info);
      }
      await store.retry(
        info,
        retryDelay(current.policy, current.attempt, clock.random),
      );
    }
  }
}
