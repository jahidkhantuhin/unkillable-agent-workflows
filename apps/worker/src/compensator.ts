import {
  sagaSchema,
  classifyError,
  type SupportMail,
} from '@unkillable/shared';
import type { RunRepository } from '@unkillable/storage';
import { noFaults, type FaultInjector } from './faults';

export async function compensate(
  repository: RunRepository,
  id: string,
  deliver: (mail: SupportMail) => Promise<void>,
  faults: FaultInjector = noFaults,
) {
  const saga = repository.saga();
  const run = await repository.get(id);
  if (!run || run.status !== 'compensating') return;
  const plan = sagaSchema.parse(run.state.saga);
  for (const node of plan.plan) {
    const current = await repository.get(id);
    if (sagaSchema.parse(current!.state.saga).completed.includes(node))
      continue;
    await repository.append(
      id,
      { type: 'CUSTOM', name: 'compensation.started', value: { nodeId: node } },
      { key: `saga:${node}:started` },
    );
    try {
      await faults.at(id, node, 'before');
      await saga.apply(id, node);
      if (node === 'send_correction_or_void')
        await repository
          .reliability()
          .deliverEmail(`${id}:${node}:reply`, deliver);
      await faults.at(id, node, 'after');
      await saga.completeNode(id, node);
    } catch (error) {
      await repository.append(
        id,
        {
          type: 'CUSTOM',
          name: 'compensation.failed',
          value: { nodeId: node, error: classifyError(error) },
        },
        { key: `saga:${node}:failed` },
      );
      throw error;
    }
  }
  await saga.finish(id);
}
