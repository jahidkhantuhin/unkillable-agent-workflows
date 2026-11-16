import { randomUUID } from 'node:crypto';
import type { MongoClient, Db, Document, IndexDescription } from 'mongodb';
import {
  approvalSchema,
  approvalDecisionSchema,
  noticePayloadSchema,
  StaleExecutionError,
  type ApprovalDecision,
} from '@unkillable/shared';
import { RunRepository } from './index';
export class ApprovalConflictError extends Error {
  constructor() {
    super(
      'This approval has changed or has already been resolved. Refresh the inbox.',
    );
  }
}
type Stored = Document & { _id: string };
export class ApprovalRepository {
  private readonly runs;
  constructor(
    private readonly client: MongoClient,
    private readonly db: Db = client.db(),
  ) {
    this.runs = new RunRepository(client, db);
  }
  async list() {
    return (
      await this.db
        .collection('approvals')
        .find({ status: 'pending' })
        .sort({ createdAt: 1 })
        .limit(100)
        .toArray()
    ).map((value) => approvalSchema.parse(value));
  }
  async get(id: string) {
    const value = await this.db.collection('approvals').findOne({ id });
    return value ? approvalSchema.parse(value) : null;
  }
  async forRun(runId: string) {
    const value = await this.db
      .collection('approvals')
      .findOne({ runId, nodeId: 'approval' });
    return value ? approvalSchema.parse(value) : null;
  }
  async request(
    runId: string,
    execution: number,
    checkpointId: string,
    message: string,
    title = '',
    context: {
      proposal?: Record<string, unknown>;
      reasoning?: string;
      requiredApprovals?: number;
    } = {},
  ) {
    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        const run = await this.runs.getInSession(runId, session);
        if (!run || run.execution !== execution)
          throw new StaleExecutionError();
        const collection = this.db.collection<Stored>('approvals');
        if (
          await collection.findOne({ runId, nodeId: 'approval' }, { session })
        )
          return;
        const now = new Date();
        const record = approvalSchema.parse({
          title,
          id: randomUUID(),
          runId,
          nodeId: 'approval',
          version: 0,
          status: 'pending',
          requiredApprovals: context.requiredApprovals ?? 1,
          proposedAction: {
            ...context.proposal,
            ...noticePayloadSchema.parse({ message }),
          },
          reasoning:
            context.reasoning ??
            'A human must review this local notice before the complete node can queue delivery. This is a deterministic demo; no AI model is used.',
          createdAt: now,
          updatedAt: now,
        });
        await collection.insertOne({ ...record, _id: record.id }, { session });
        await this.runs.appendInSession(
          runId,
          {
            type: 'CUSTOM',
            name: 'approval.requested',
            value: {
              approvalId: record.id,
              proposedAction: record.proposedAction,
              reasoning: record.reasoning,
              checkpointId,
            },
          },
          {
            key: 'approval:requested',
            status: 'waiting_approval',
            dispatchPending: false,
            expectedExecution: execution,
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
  }
  async resolve(
    id: string,
    version: number,
    input: ApprovalDecision,
    actorId: string,
  ) {
    const decision = approvalDecisionSchema.parse(input);
    const session = this.client.startSession();
    try {
      return await session.withTransaction(async () => {
        const collection = this.db.collection<Stored>('approvals');
        const doc = await collection.findOne({ id }, { session });
        if (!doc) return null;
        const record = approvalSchema.parse(doc);
        if (
          record.proposedAction.kind === 'moderation' &&
          decision.action === 'edit'
        )
          throw new ApprovalConflictError();
        const run = await this.runs.getInSession(record.runId, session);
        if (
          record.status !== 'pending' ||
          record.version !== version ||
          run?.status !== 'waiting_approval'
        )
          throw new ApprovalConflictError();
        const now = new Date();
        if (record.reviews.some((review) => review.actorId === actorId))
          throw new ApprovalConflictError();
        if (record.reviews.length && decision.action === 'edit')
          throw new ApprovalConflictError();
        const reviews = [
          ...record.reviews,
          {
            actorId,
            action: decision.action,
            at: now,
            ...(decision.action === 'edit'
              ? {
                  message: decision.payload.message,
                  ...(decision.reason ? { reason: decision.reason } : {}),
                }
              : decision.action === 'reject'
                ? { reason: decision.reason }
                : {}),
          },
        ];
        const final =
          decision.action === 'reject' ||
          reviews.length >= record.requiredApprovals;
        const previousEdit = record.reviews.find(
          (review) => review.action === 'edit',
        );
        const effectiveDecision: ApprovalDecision =
          decision.action === 'approve' && previousEdit?.message
            ? {
                action: 'edit',
                payload: { message: previousEdit.message },
                ...(previousEdit.reason ? { reason: previousEdit.reason } : {}),
              }
            : decision;
        const next = approvalSchema.parse({
          ...record,
          reviews,
          status: !final
            ? 'pending'
            : effectiveDecision.action === 'approve'
              ? 'approved'
              : effectiveDecision.action === 'edit'
                ? 'edited'
                : 'rejected',
          version: version + 1,
          resolvedBy: final ? actorId : undefined,
          resolvedAt: final ? now : undefined,
          updatedAt: now,
          decision: final ? effectiveDecision : undefined,
        });
        const changed = await collection.replaceOne(
          { id, version, status: 'pending' },
          {
            ...Object.fromEntries(
              Object.entries(next).filter(([, value]) => value !== undefined),
            ),
            _id: record.id,
          },
          { session },
        );
        if (changed.modifiedCount !== 1) throw new ApprovalConflictError();
        if (!final) {
          await this.runs.appendInSession(
            run.id,
            {
              type: 'CUSTOM',
              name: 'approval.reviewed',
              value: {
                approvalId: id,
                actorId,
                decision,
                count: reviews.length,
                required: record.requiredApprovals,
              },
            },
            {
              key: `approval:reviewed:${id}:${actorId}`,
              expectedExecution: run.execution,
            },
            session,
          );
          return run.id;
        }
        await this.runs.appendInSession(
          run.id,
          {
            type: 'CUSTOM',
            name: 'approval.resolved',
            value: {
              approvalId: id,
              actorId,
              decision: effectiveDecision,
              reviews,
              proposedAction: record.proposedAction,
              resolvedAt: now.toISOString(),
              execution: run.execution + 1,
            },
          },
          {
            key: `approval:resolved:${id}`,
            status: 'queued',
            execution: run.execution + 1,
            dispatchPending: true,
            expectedExecution: run.execution,
          },
          session,
        );
        return run.id;
      });
    } finally {
      await session.endSession();
    }
  }
}
export const approvalIndexes: Record<string, IndexDescription[]> = {
  approvals: [
    { key: { runId: 1, nodeId: 1 }, unique: true },
    { key: { status: 1, createdAt: 1 } },
  ],
};
