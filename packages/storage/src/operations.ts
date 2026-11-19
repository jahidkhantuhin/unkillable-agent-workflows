import type { Db, MongoClient, Document } from 'mongodb';
import {
  approvalSchema,
  runSchema,
  usageSchema,
  spanRecordSchema,
  runMetricsSchema,
  workflowCostsSchema,
  slaJobSchema,
} from '@unkillable/shared';
import { RunRepository } from './index';
import { ApprovalRepository, ApprovalConflictError } from './approvals';
type Stored = Document & { _id: string };
export const operationsIndexes = {
  runUsage: [{ key: { runId: 1, at: 1 } }],
  runSpans: [{ key: { runId: 1, startedAt: 1 } }],
};
export class OperationsRepository {
  constructor(
    private readonly client: MongoClient,
    private readonly db: Db = client.db(),
    private readonly now: () => Date = () => new Date(),
  ) {}
  async usage(value: unknown) {
    const row = usageSchema.parse(value);
    await this.db
      .collection<Stored>('runUsage')
      .updateOne({ _id: row.id }, { $setOnInsert: row }, { upsert: true });
  }
  async span(value: unknown) {
    const row = spanRecordSchema.parse(value);
    await this.db.collection<Stored>('runSpans').updateOne(
      { _id: row.id },
      {
        $setOnInsert: Object.fromEntries(
          Object.entries(row).filter(([, value]) => value !== undefined),
        ),
      },
      { upsert: true },
    );
  }
  async scheduled() {
    return (
      await this.db
        .collection('approvals')
        .find({ status: 'pending', sla: { $exists: true } })
        .toArray()
    ).map((row) => approvalSchema.parse(row));
  }
  async timer(input: unknown) {
    const { approvalId, stage } = slaJobSchema.parse(input),
      session = this.client.startSession();
    try {
      return await session.withTransaction(async () => {
        const row = await this.db
          .collection('approvals')
          .findOne({ id: approvalId }, { session });
        if (!row) return false;
        const a = approvalSchema.parse(row),
          now = this.now();
        if (a.status !== 'pending' || !a.sla) return false;
        const due =
          stage === 'remind'
            ? a.sla.remindAt
            : stage === 'escalate'
              ? a.sla.escalateAt
              : a.sla.expireAt;
        const field =
          stage === 'remind'
            ? 'remindedAt'
            : stage === 'escalate'
              ? 'escalatedAt'
              : 'expiredAt';
        if (
          a.sla[field] ||
          +now < +due ||
          (stage !== 'expire' && +now >= +a.sla.expireAt)
        )
          return false;
        const runs = new RunRepository(this.client, this.db),
          run = await runs.getInSession(a.runId, session);
        if (!run || run.status !== 'waiting_approval') return false;
        await this.db
          .collection('approvals')
          .updateOne(
            { id: a.id, status: 'pending', version: a.version },
            { $set: { [`sla.${field}`]: now } },
            { session },
          );
        if (stage === 'expire') {
          if (a.sla.timeoutAction === 'reject') {
            await new ApprovalRepository(this.client, this.db).resolve(
              a.id,
              a.version,
              { action: 'reject', reason: 'Approval SLA deadline expired' },
              'system:sla',
              session,
            );
          } else {
            await this.db.collection('approvals').updateOne(
              { id: a.id, version: a.version, status: 'pending' },
              {
                $set: {
                  status: 'rejected',
                  resolvedBy: 'system:sla',
                  resolvedAt: now,
                  updatedAt: now,
                  decision: {
                    action: 'reject',
                    reason: 'Approval SLA cancelled the run',
                  },
                },
                $inc: { version: 1 },
              },
              { session },
            );
            await runs.appendInSession(
              run.id,
              {
                type: 'CUSTOM',
                name: 'approval.cancelled',
                value: { approvalId: a.id, actorId: 'system:sla' },
              },
              {
                key: `sla-cancel-${a.id}`,
                status: 'cancelled',
                dispatchPending: false,
                expectedExecution: run.execution,
              },
              session,
            );
          }
        } else {
          const members =
            stage === 'escalate'
              ? await this.db
                  .collection('memberships')
                  .find(
                    { workspaceId: 'local', role: a.sla.escalateRole },
                    { session },
                  )
                  .toArray()
              : null;
          const filter = {
            approvalId: a.id,
            ...(members
              ? { userId: { $in: members.map((m) => String(m.userId)) } }
              : {}),
          };
          for (const collection of [
            'approvalNotifications',
            'whatsappNotifications',
          ])
            await this.db
              .collection(collection)
              .updateMany(
                filter,
                { $set: { status: 'pending', attempts: 0, nextAt: now } },
                { session },
              );
        }
        await runs.appendInSession(
          run.id,
          {
            type: 'CUSTOM',
            name: `approval.sla.${stage}`,
            value: {
              approvalId: a.id,
              targetRole: stage === 'escalate' ? a.sla.escalateRole : null,
              timeoutAction: a.sla.timeoutAction,
              at: now.toISOString(),
            },
          },
          { key: `sla-${a.id}-${stage}`, allowTerminal: stage === 'expire' },
          session,
        );
        return true;
      });
    } catch (error) {
      if (error instanceof ApprovalConflictError) return false;
      throw error;
    } finally {
      await session.endSession();
    }
  }
  async metrics(id: string) {
    const raw = await this.db.collection('runs').findOne({ id });
    if (!raw) return null;
    const run = runSchema.parse(raw);
    const usage = (
      await this.db.collection('runUsage').find({ runId: id }).toArray()
    ).map((row) => usageSchema.parse(row));
    const spans = (
      await this.db
        .collection('runSpans')
        .find({ runId: id })
        .sort({ startedAt: 1 })
        .toArray()
    ).map((row) => spanRecordSchema.parse(row));
    const approval = await new ApprovalRepository(this.client, this.db).forRun(
      id,
    );
    const end = ['succeeded', 'failed', 'cancelled', 'compensated'].includes(
      run.status,
    )
      ? run.updatedAt
      : this.now();
    return runMetricsSchema.parse({
      runId: id,
      workflowId: run.workflowId,
      elapsedMs: Math.max(0, +end - +run.createdAt),
      approvalWaitMs: approval
        ? Math.max(
            0,
            +(approval.resolvedAt ?? this.now()) - +approval.createdAt,
          )
        : 0,
      inputTokens: usage.reduce((s, u) => s + (u.inputTokens ?? 0), 0),
      outputTokens: usage.reduce((s, u) => s + (u.outputTokens ?? 0), 0),
      knownCostUsd: usage.reduce((s, u) => s + (u.costUsd ?? 0), 0),
      unpricedCalls: usage.filter((u) => u.costUsd === null).length,
      missingUsageCalls: usage.filter(
        (u) => u.inputTokens === null || u.outputTokens === null,
      ).length,
      calls: usage.length,
      spans: spans.map((s) => ({ ...s, startedAt: s.startedAt.toISOString() })),
    });
  }
  async costs() {
    const rows = await this.db
      .collection('runs')
      .aggregate([
        {
          $lookup: {
            from: 'runUsage',
            localField: 'id',
            foreignField: 'runId',
            as: 'usage',
          },
        },
        {
          $project: {
            workflowId: 1,
            calls: { $size: '$usage' },
            inputTokens: { $sum: '$usage.inputTokens' },
            outputTokens: { $sum: '$usage.outputTokens' },
            knownCostUsd: { $sum: '$usage.costUsd' },
            unpricedCalls: {
              $size: {
                $filter: {
                  input: '$usage',
                  as: 'u',
                  cond: { $eq: ['$$u.costUsd', null] },
                },
              },
            },
          },
        },
        {
          $group: {
            _id: '$workflowId',
            runs: { $sum: 1 },
            calls: { $sum: '$calls' },
            inputTokens: { $sum: '$inputTokens' },
            outputTokens: { $sum: '$outputTokens' },
            knownCostUsd: { $sum: '$knownCostUsd' },
            unpricedCalls: { $sum: '$unpricedCalls' },
          },
        },
      ])
      .toArray();
    return workflowCostsSchema.parse({
      scope:
        'All retained runs; known estimated USD only, not a provider invoice',
      workflows: rows.map((r) => ({ ...r, workflowId: r._id })),
    });
  }
}
