import type { MongoClient, Db } from 'mongodb';
import { createHash } from 'node:crypto';
import { RunRepository } from './index';
import { ReliabilityRepository } from './reliability';
import { SupportRepository } from './support';
import {
  sagaSchema,
  supportStateSchema,
  effectResultSchema,
  PermanentError,
  type CompensationNode,
} from '@unkillable/shared';

/** Registry order is the reverse of the forward effect order. */
export const compensationRegistry = [
  { forward: 'close_ticket', action: 'reopen_ticket', key: 'close' },
  { forward: 'send_email', action: 'send_correction_or_void', key: 'reply' },
  { forward: 'issue_refund', action: 'reverse_refund', key: 'refund' },
] as const;

export class SagaRepository {
  private readonly runs;
  private readonly reliability;
  constructor(
    private readonly client: MongoClient,
    private readonly db: Db = client.db(),
  ) {
    this.runs = new RunRepository(client, db);
    this.reliability = new ReliabilityRepository(client, db);
  }
  async pending() {
    return (
      await this.db
        .collection('runs')
        .find({ status: 'compensating' })
        .limit(100)
        .toArray()
    ).map((row) => String(row.id));
  }
  async begin(id: string, execution: number, failure: string) {
    const session = this.client.startSession();
    try {
      return await session.withTransaction(async () => {
        const run = await this.runs.getInSession(id, session);
        if (!run || run.execution !== execution) return false;
        if (run.status === 'compensating' || run.status === 'compensated')
          return true;
        if (run.status !== 'running') return false;
        const receipts = await this.db
          .collection('idempotencyKeys')
          .find({ runId: id, status: 'completed' }, { session })
          .toArray();
        const plan = compensationRegistry
          .filter((entry) =>
            receipts.some(
              (row) => row.key === `${id}:${entry.forward}:${entry.key}`,
            ),
          )
          .map((entry) => entry.action);
        if (!plan.length) return false;
        const saga = sagaSchema.parse({ plan, completed: [], failure });
        await this.db.collection('outbox').updateMany(
          { runId: id, kind: 'email', status: 'pending' },
          {
            $set: {
              status: 'failed',
              lastError: 'Forward delivery stopped for compensation',
              updatedAt: new Date(),
            },
          },
          { session },
        );
        await this.runs.appendInSession(
          id,
          {
            type: 'CUSTOM',
            name: 'compensation.started',
            value: { plan, failure },
          },
          {
            key: 'saga:started',
            status: 'compensating',
            error: failure,
            state: { ...run.state, saga },
            expectedExecution: execution,
          },
          session,
        );
        return true;
      });
    } finally {
      await session.endSession();
    }
  }
  async apply(id: string, node: CompensationNode) {
    const run = await this.runs.get(id);
    if (run?.status === 'compensated') return;
    if (!run || run.status !== 'compensating')
      throw new PermanentError('Compensation requires a compensating run');
    const state = supportStateSchema.parse(run.state);
    if (node === 'send_correction_or_void') {
      // A failed SMTP acknowledgement cannot establish whether the original was captured.
      // Always issue one explicit correction for a persisted reply intent.
      await new SupportRepository(this.client, this.db).queueEmail(
        id,
        state.ticketId,
        {
          to: state.ticket.customerEmail,
          subject: `Correction: ${state.title.replace(/[\r\n]/g, ' ')}`,
          text: 'This simulated support workflow failed. Its previous reply is void; any fake refund is being reversed. No real payment was made.',
        },
        node,
      );
      return;
    }
    await this.reliability.executeOnce(
      `${id}:${node}:undo`,
      async ({ session }) => {
        if (node === 'reverse_refund') {
          const refund = await this.db
            .collection('fakeRefunds')
            .findOne({ runId: id }, { session });
          if (!refund)
            throw new PermanentError(
              'Refund receipt missing during compensation',
            );
          await this.db
            .collection('fakeRefunds')
            .updateOne(
              { runId: id },
              { $set: { status: 'reversed', reversedAt: new Date() } },
              { session },
            );
        } else {
          const result = await this.db
            .collection('tickets')
            .updateOne(
              { id: state.ticketId },
              { $set: { status: 'open', updatedAt: new Date() } },
              { session },
            );
          if (result.matchedCount !== 1)
            throw new PermanentError('Ticket missing during compensation');
        }
        return {
          receipt: createHash('sha256').update(`${id}:${node}`).digest('hex'),
        };
      },
      effectResultSchema,
    );
  }
  async completeNode(id: string, node: CompensationNode) {
    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        const run = await this.runs.getInSession(id, session);
        if (!run || run.status === 'compensated') return;
        const saga = sagaSchema.parse(run.state.saga);
        if (saga.completed.includes(node)) return;
        if (saga.plan[saga.completed.length] !== node)
          throw new PermanentError('Compensation order mismatch');
        const state: Record<string, unknown> = {
          ...run.state,
          saga: { ...saga, completed: [...saga.completed, node] },
        };
        if (node === 'reopen_ticket') state.ticketStatus = 'open';
        await this.runs.appendInSession(
          id,
          {
            type: 'CUSTOM',
            name: 'compensation.finished',
            value: { nodeId: node },
          },
          { key: `saga:${node}:finished`, state },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
  }
  async finish(id: string) {
    const run = await this.runs.get(id);
    if (!run || run.status === 'compensated') return;
    const saga = sagaSchema.parse(run.state.saga);
    if (saga.completed.length !== saga.plan.length)
      throw new PermanentError('Compensation is incomplete');
    await this.runs.append(
      id,
      { type: 'STATE_SNAPSHOT', snapshot: run.state },
      { key: 'saga:snapshot', state: run.state },
    );
    await this.runs.append(
      id,
      { type: 'RUN_FINISHED', outcome: 'compensated' },
      { key: 'saga:finished', status: 'compensated' },
    );
  }
}
