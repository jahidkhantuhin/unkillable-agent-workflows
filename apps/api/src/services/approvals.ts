import {
  ApprovalConflictError,
  type ApprovalRepository,
} from '@unkillable/storage';
import { approvalDTOSchema, type ApprovalDecision } from '@unkillable/shared';
import { HttpError } from '../errors';
import type { RunService } from './runs';
function dto(
  record: NonNullable<Awaited<ReturnType<ApprovalRepository['get']>>>,
) {
  return approvalDTOSchema.parse({
    ...record,
    reviews: record.reviews.map((review) => ({
      ...review,
      at: review.at.toISOString(),
    })),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    resolvedAt: record.resolvedAt?.toISOString(),
  });
}
export class ApprovalService {
  constructor(
    private readonly repository: ApprovalRepository,
    private readonly runs: RunService,
  ) {}
  async list(role = 'admin') {
    return (await this.repository.list())
      .filter(
        (record) =>
          role === 'admin' || record.proposedAction.kind !== 'moderation',
      )
      .map(dto);
  }
  async get(id: string, role = 'admin') {
    const record = await this.repository.get(id);
    if (!record)
      throw new HttpError(404, 'APPROVAL_NOT_FOUND', 'Approval not found');
    if (record.proposedAction.kind === 'moderation' && role !== 'admin')
      throw new HttpError(
        403,
        'FORBIDDEN',
        'Moderation review requires an administrator',
      );
    return dto(record);
  }
  async resolve(
    id: string,
    version: number,
    decision: ApprovalDecision,
    actorId: string,
    role = 'admin',
  ) {
    try {
      await this.get(id, role);
      const runId = await this.repository.resolve(
        id,
        version,
        decision,
        actorId,
      );
      if (!runId)
        throw new HttpError(404, 'APPROVAL_NOT_FOUND', 'Approval not found');
      // The durable dispatch marker survives a queue outage or API restart.
      await this.runs.reconcile().catch(() => {});
      return { runId };
    } catch (error) {
      if (error instanceof ApprovalConflictError)
        throw new HttpError(409, 'APPROVAL_CONFLICT', error.message);
      throw error;
    }
  }
}
