import { randomUUID } from 'node:crypto';
import type { Db, MongoClient, IndexDescription } from 'mongodb';
import {
  moderationItemSchema,
  moderationStateSchema,
  moderationWorkflowId,
  effectResultSchema,
  PermanentError,
  type ModerationState,
  type CompensationNode,
} from '@unkillable/shared';
import { ReliabilityRepository } from './reliability';
export const moderationIndexes: Record<string, IndexDescription[]> = {
  moderationItems: [
    { key: { runId: 1 }, unique: true },
    { key: { status: 1, createdAt: -1 } },
  ],
  publishedContent: [{ key: { runId: 1 }, unique: true }],
};
export class ModerationRepository {
  async hasFile(key: string) {
    return !!(await this.db
      .collection('moderationItems')
      .findOne({ 'file.key': key }, { projection: { id: 1 } }));
  }
  constructor(
    private readonly client: MongoClient,
    private readonly db: Db = client.db(),
  ) {}
  async item(runId: string) {
    const doc = await this.db.collection('moderationItems').findOne({ runId });
    return doc ? moderationItemSchema.parse(doc) : null;
  }
  async queue() {
    const docs = await this.db
      .collection('runs')
      .find({ workflowId: moderationWorkflowId })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();
    const items = [];
    for (const run of docs) {
      const item = await this.item(run.id);
      if (item)
        items.push({
          ...item,
          createdAt: item.createdAt.toISOString(),
          updatedAt: item.updatedAt.toISOString(),
          decidedAt: item.decidedAt?.toISOString(),
          runStatus: run.status,
          decisionReason: moderationStateSchema.parse(run.state).decisionReason,
        });
    }
    return {
      items,
      backlog: await this.db.collection('runs').countDocuments({
        workflowId: moderationWorkflowId,
        status: {
          $in: ['queued', 'running', 'waiting_approval', 'compensating'],
        },
      }),
      waitingReview: await this.db.collection('runs').countDocuments({
        workflowId: moderationWorkflowId,
        status: 'waiting_approval',
      }),
      decisionsLast24Hours: await this.db
        .collection('moderationItems')
        .countDocuments({
          status: { $in: ['published', 'rejected'] },
          decidedAt: { $gte: new Date(Date.now() - 86400000) },
        }),
    };
  }
  async decide(runId: string, state: ModerationState, publish: boolean) {
    if (publish && state.decision !== 'allow')
      throw new PermanentError('Publishing requires an allowed decision');
    const node = publish ? 'publish' : 'reject',
      suffix = publish ? 'publication' : 'decision';
    return new ReliabilityRepository(this.client, this.db).executeOnce(
      `${runId}:${node}:${suffix}`,
      async ({ session }) => {
        const now = new Date();
        const claimed = await this.db
          .collection('runs')
          .updateOne(
            { id: runId, status: 'running' },
            { $inc: { effectFence: 1 } },
            { session },
          );
        if (!claimed.matchedCount)
          throw new PermanentError(
            'Moderation effects require a running execution',
          );
        const item = moderationItemSchema.parse(
          await this.db
            .collection('moderationItems')
            .findOne({ id: state.contentId, runId }, { session }),
        );
        if (publish)
          await this.db.collection('publishedContent').insertOne(
            {
              id: randomUUID(),
              runId,
              contentId: item.id,
              file: item.file,
              status: 'published',
              createdAt: now,
            },
            { session },
          );
        await this.db.collection('moderationItems').updateOne(
          { id: item.id },
          {
            $set: {
              status: publish ? 'published' : 'rejected',
              decidedAt: now,
              updatedAt: now,
            },
          },
          { session },
        );
        return { receipt: `${runId}:${node}` };
      },
      effectResultSchema,
    );
  }
  async notify(runId: string, state: ModerationState) {
    return new ReliabilityRepository(this.client, this.db).executeOnce(
      `${runId}:notify:notice`,
      async ({ enqueue, session }) => {
        const claimed = await this.db
          .collection('runs')
          .updateOne(
            { id: runId, status: 'running' },
            { $inc: { effectFence: 1 } },
            { session },
          );
        if (!claimed.matchedCount)
          throw new PermanentError(
            'Moderation notification requires a running execution',
          );
        const receipt = await enqueue('notification', {
          kind: 'moderation',
          contentId: state.contentId,
          title: state.title,
          outcome: state.decision === 'allow' ? 'published' : 'rejected',
        });
        return { receipt };
      },
      effectResultSchema,
    );
  }
  async undo(runId: string, node: CompensationNode) {
    await new ReliabilityRepository(this.client, this.db).executeOnce(
      `${runId}:${node}:undo`,
      async ({ session }) => {
        if (node === 'void_moderation_notice') {
          await this.db.collection('outbox').updateMany(
            { runId, kind: 'notification' },
            {
              $set: {
                status: 'failed',
                lastError: 'Moderation outcome withdrawn',
                updatedAt: new Date(),
              },
            },
            { session },
          );
          await this.db
            .collection('localDeliveries')
            .updateMany({ runId }, { $set: { voided: true } }, { session });
        } else {
          await this.db
            .collection('publishedContent')
            .updateMany(
              { runId },
              { $set: { status: 'withdrawn' } },
              { session },
            );
          await this.db
            .collection('moderationItems')
            .updateOne(
              { runId },
              { $set: { status: 'withdrawn', updatedAt: new Date() } },
              { session },
            );
        }
        return { receipt: `${runId}:${node}` };
      },
      effectResultSchema,
    );
  }
}
