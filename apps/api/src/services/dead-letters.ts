import { ConflictError, type ReliabilityRepository } from '@unkillable/storage';
import { deadLetterDTOSchema } from '@unkillable/shared';
import type { RunService } from './runs';
import { HttpError } from '../errors';
function dto(
  letter: NonNullable<Awaited<ReturnType<ReliabilityRepository['deadLetter']>>>,
) {
  return deadLetterDTOSchema.parse({
    ...letter,
    createdAt: letter.createdAt.toISOString(),
    updatedAt: letter.updatedAt.toISOString(),
  });
}
export class DeadLetterService {
  constructor(
    private readonly reliability: ReliabilityRepository,
    private readonly runs: RunService,
  ) {}
  async list() {
    return (await this.reliability.deadLetters()).map(dto);
  }
  async get(id: string) {
    const letter = await this.reliability.deadLetter(id);
    if (!letter)
      throw new HttpError(
        404,
        'DEAD_LETTER_NOT_FOUND',
        'Dead letter not found',
      );
    return dto(letter);
  }
  async resolve(
    id: string,
    version: number,
    action: 'retry' | 'discard',
    actorId: string,
  ) {
    try {
      const runId = await this.reliability.resolveDeadLetter(
        id,
        version,
        action,
        actorId,
      );
      if (!runId)
        throw new HttpError(
          404,
          'DEAD_LETTER_NOT_FOUND',
          'Dead letter not found',
        );
      if (action === 'retry') {
        try {
          await this.runs.reconcile();
        } catch {
          /* Durable pending dispatch is recovered by the API loop. */
        }
      }
      return { runId };
    } catch (error) {
      if (error instanceof ConflictError)
        throw new HttpError(409, 'DEAD_LETTER_CONFLICT', error.message);
      throw error;
    }
  }
}
