import type { Db, Document, MongoClient, IndexDescription } from 'mongodb';
import {
  approvalPolicySchema,
  policyDecisionSchema,
  policyInputsSchema,
  defaultApprovalPolicy,
  evaluateApprovalPolicy,
  supportStateSchema,
  type ApprovalPolicy,
  type PolicyInputs,
} from '@unkillable/shared';
import { RunRepository } from './index';
export class PolicyConflictError extends Error {}
type Stored = Document & { _id: string };
export const policyIndexes: Record<string, IndexDescription[]> = {
  approvalPolicyVersions: [{ key: { version: 1 }, unique: true }],
  policyDecisions: [
    { key: { runId: 1 }, unique: true },
    { key: { createdAt: 1 } },
  ],
};
export class PolicyRepository {
  constructor(
    private readonly client: MongoClient,
    private readonly db: Db = client.db(),
  ) {}
  async current() {
    const head = await this.db
      .collection<Stored>('approvalPolicyHead')
      .findOne({ _id: 'support' });
    if (!head)
      return {
        version: 0,
        policy: defaultApprovalPolicy,
        actorId: 'built-in',
        createdAt: null as Date | null,
      };
    return {
      version: Number(head.version),
      policy: approvalPolicySchema.parse(head.policy),
      actorId: String(head.actorId),
      createdAt: new Date(head.createdAt),
    };
  }
  async history() {
    const records = await this.db
      .collection('approvalPolicyVersions')
      .find({})
      .sort({ version: -1 })
      .limit(100)
      .toArray();
    return records.map((r) => ({
      version: Number(r.version),
      policy: approvalPolicySchema.parse(r.policy),
      actorId: String(r.actorId),
      createdAt: r.createdAt,
    }));
  }
  async save(expectedVersion: number, raw: ApprovalPolicy, actorId: string) {
    const policy = approvalPolicySchema.parse(raw);
    const session = this.client.startSession();
    try {
      return await session.withTransaction(async () => {
        const collection = this.db.collection<Stored>('approvalPolicyHead');
        const old = await collection.findOne({ _id: 'support' }, { session });
        if ((old?.version ?? 0) !== expectedVersion)
          throw new PolicyConflictError(
            'Policy changed. Reload before saving.',
          );
        const next = {
          version: expectedVersion + 1,
          policy,
          actorId,
          createdAt: new Date(),
        };
        if (old)
          await collection.replaceOne(
            { _id: 'support', version: expectedVersion },
            { _id: 'support', ...next },
            { session },
          );
        else
          await collection.insertOne({ _id: 'support', ...next }, { session });
        await this.db
          .collection('approvalPolicyVersions')
          .insertOne(next, { session });
        return next;
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000)
        throw new PolicyConflictError('Policy changed. Reload before saving.');
      throw error;
    } finally {
      await session.endSession();
    }
  }
  async decide(runId: string, inputs: PolicyInputs) {
    const session = this.client.startSession();
    try {
      return await session.withTransaction(async () => {
        const decisions = this.db.collection<Stored>('policyDecisions');
        const existing = await decisions.findOne({ _id: runId }, { session });
        if (existing) return policyDecisionSchema.parse(existing.decision);
        const head = await this.db
          .collection<Stored>('approvalPolicyHead')
          .findOne({ _id: 'support' }, { session });
        const decision = evaluateApprovalPolicy(
          head
            ? approvalPolicySchema.parse(head.policy)
            : defaultApprovalPolicy,
          inputs,
          head?.version ?? 0,
        );
        await decisions.insertOne(
          { _id: runId, runId, decision, createdAt: new Date() },
          { session },
        );
        await new RunRepository(this.client, this.db).appendInSession(
          runId,
          { type: 'CUSTOM', name: 'policy.evaluated', value: decision },
          { key: 'policy:evaluated' },
          session,
        );
        return decision;
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        const existing = await this.db
          .collection('policyDecisions')
          .findOne({ runId });
        if (existing) return policyDecisionSchema.parse(existing.decision);
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }
  async decideSupport(runId: string, state: unknown, refundCents: number) {
    const parsed = supportStateSchema.parse(state);
    const run = await new RunRepository(this.client, this.db).get(runId);
    if (!run) throw new Error('Run not found');
    return this.decide(runId, {
      action: 'support_reply',
      amountCents: refundCents,
      riskTier:
        refundCents > 0 || parsed.classification.confidence < 0.8
          ? 'high'
          : 'low',
      confidence: parsed.classification.confidence,
      customerTier: parsed.ticket.customerTier ?? 'standard',
      hourUtc: run.createdAt.getUTCHours(),
    });
  }
  async dryRun(raw: ApprovalPolicy) {
    const policy = approvalPolicySchema.parse(raw);
    const records = await this.db
      .collection('policyDecisions')
      .find({})
      .sort({ createdAt: -1, _id: 1 })
      .limit(100)
      .toArray();
    return {
      limit: 100,
      total: await this.db.collection('policyDecisions').countDocuments(),
      results: records.map((r) => {
        const before = policyDecisionSchema.parse(r.decision);
        const after = evaluateApprovalPolicy(
          policy,
          policyInputsSchema.parse(before.inputs),
          before.version,
        );
        return {
          runId: String(r.runId),
          before: before.outcome,
          after: after.outcome,
          changed: before.outcome !== after.outcome,
          decision: after,
        };
      }),
    };
  }
  async analytics() {
    // Aggregate all persisted decisions; no hidden pagination/cap on metric denominators.
    const cursor = this.db
      .collection('policyDecisions')
      .find({})
      .sort({ createdAt: 1 });
    let evaluated = 0,
      humanRequired = 0,
      autoApproved = 0,
      resolved = 0,
      edited = 0,
      rejected = 0;
    const waits: number[] = [],
      reasons = new Map<string, number>();
    const feedback: {
      runId: string;
      actorId: string;
      action: string;
      original: string;
      edited: string | null;
      reason: string | null;
      at: string;
    }[] = [];
    const days = new Map<
      string,
      { date: string; evaluated: number; autoApproved: number }
    >();
    for await (const row of cursor) {
      const decision = policyDecisionSchema.parse(row.decision);
      evaluated++;
      const day = new Date(row.createdAt).toISOString().slice(0, 10);
      const bucket = days.get(day) ?? {
        date: day,
        evaluated: 0,
        autoApproved: 0,
      };
      bucket.evaluated++;
      if (decision.outcome === 'auto_approve') {
        autoApproved++;
        bucket.autoApproved++;
      } else humanRequired++;
      days.set(day, bucket);
      const approval = await this.db
        .collection('approvals')
        .findOne({ runId: row.runId, nodeId: 'approval' });
      for (const review of approval?.reviews ?? []) {
        if (review.action === 'edit' || review.action === 'reject')
          feedback.push({
            runId: String(row.runId),
            actorId: String(review.actorId),
            action: review.action,
            original: String(approval?.proposedAction.message ?? ''),
            edited: review.message ?? null,
            reason: review.reason ?? null,
            at: new Date(review.at).toISOString(),
          });
      }
      if (!approval || approval.status === 'pending') continue;
      resolved++;
      if (approval.status === 'edited') edited++;
      if (approval.status === 'rejected') {
        rejected++;
        const reason = String(approval.decision?.reason ?? 'Not recorded');
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      } else if (approval.resolvedAt)
        waits.push(
          new Date(approval.resolvedAt).getTime() -
            new Date(approval.createdAt).getTime(),
        );
    }
    waits.sort((a, b) => a - b);
    const median = waits.length
      ? (waits[Math.floor((waits.length - 1) / 2)] +
          waits[Math.floor(waits.length / 2)]) /
        2
      : null;
    return {
      scope:
        'All persisted support policy decisions; legacy/demo runs excluded',
      evaluated,
      humanRequired,
      autoApproved,
      humanApprovalRate: evaluated ? humanRequired / evaluated : null,
      resolved,
      edited,
      rejected,
      editRate: resolved ? edited / resolved : null,
      medianTimeToApproveMs: median,
      approvedSamples: waits.length,
      rejectionReasons: Array.from(reasons, ([reason, count]) => ({
        reason,
        count,
      })),
      daily: Array.from(days.values()).map((d) => ({
        ...d,
        autoApprovedShare: d.autoApproved / d.evaluated,
      })),
      feedback: feedback.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50),
    };
  }
}
