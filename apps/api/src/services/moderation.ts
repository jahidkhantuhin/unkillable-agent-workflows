import type { Readable } from 'node:stream';
import { LocalContentStorage, type ContentStorage } from '@unkillable/storage';
import { HttpError } from '../errors';
import type { RunService } from './runs';
export class ModerationService {
  constructor(
    private readonly runs: RunService,
    readonly files: ContentStorage = new LocalContentStorage(),
  ) {}
  async upload(source: Readable, title: string, actor: string) {
    const file = await this.files.put(source);
    try {
      return await this.runs.createModeration(actor, { title, file });
    } catch (error) {
      const referenced = await this.runs.repository
        .moderation()
        .hasFile(file.key)
        .catch(() => true);
      if (!referenced) await this.files.remove(file.key).catch(() => {});
      throw error;
    }
  }
  list() {
    return this.runs.repository.moderation().queue();
  }
  async content(runId: string) {
    const item = await this.runs.repository.moderation().item(runId);
    if (!item)
      throw new HttpError(
        404,
        'CONTENT_NOT_FOUND',
        'Moderation content not found',
      );
    return this.files.open(item.file.key);
  }
}
