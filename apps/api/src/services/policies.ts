import {
  PolicyConflictError,
  type PolicyRepository,
} from '@unkillable/storage';
import type { ApprovalPolicy } from '@unkillable/shared';
import { HttpError } from '../errors';
export class PolicyService {
  constructor(private readonly repository: PolicyRepository) {}
  async list() {
    return {
      current: await this.repository.current(),
      history: await this.repository.history(),
    };
  }
  async save(version: number, policy: ApprovalPolicy, actor: string) {
    try {
      return await this.repository.save(version, policy, actor);
    } catch (error) {
      if (error instanceof PolicyConflictError)
        throw new HttpError(409, 'POLICY_CONFLICT', error.message);
      throw error;
    }
  }
  dryRun(policy: ApprovalPolicy) {
    return this.repository.dryRun(policy);
  }
  analytics() {
    return this.repository.analytics();
  }
}
