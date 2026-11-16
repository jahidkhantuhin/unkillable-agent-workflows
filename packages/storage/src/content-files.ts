import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { contentFileSchema, maxContentBytes } from '@unkillable/shared';
export interface ContentStorage {
  put(source: Readable): Promise<ReturnType<typeof contentFileSchema.parse>>;
  readText(key: string): Promise<string>;
  remove(key: string): Promise<void>;
  open(key: string): Readable;
}
export class ContentUploadError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export class LocalContentStorage implements ContentStorage {
  constructor(
    private readonly directory = fileURLToPath(
      new URL('../../../.local/moderation/', import.meta.url),
    ),
  ) {}
  private path(key: string) {
    if (!/^[0-9a-f-]{36}\.txt$/.test(key))
      throw new Error('Invalid content storage key');
    return resolve(this.directory, key);
  }
  async put(source: Readable) {
    await mkdir(this.directory, { recursive: true });
    const key = `${randomUUID()}.txt`,
      target = this.path(key),
      hash = createHash('sha256');
    let bytes = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try {
          bytes += chunk.length;
          if (bytes > maxContentBytes)
            throw new ContentUploadError(
              413,
              'Text uploads must not exceed 10 MiB',
            );
          decoder.decode(chunk, { stream: true });
          hash.update(chunk);
          callback(null, chunk);
        } catch (error) {
          callback(
            error instanceof ContentUploadError
              ? error
              : new ContentUploadError(
                  400,
                  'Upload must contain valid UTF-8 text',
                ),
          );
        }
      },
      flush(callback) {
        try {
          decoder.decode();
          if (!bytes)
            throw new ContentUploadError(400, 'Upload cannot be empty');
          callback();
        } catch (e) {
          callback(
            e instanceof ContentUploadError
              ? e
              : new ContentUploadError(
                  400,
                  'Upload must contain valid UTF-8 text',
                ),
          );
        }
      },
    });
    try {
      await pipeline(
        source,
        limiter,
        createWriteStream(target, { flags: 'wx', mode: 0o600 }),
      );
      return contentFileSchema.parse({
        key,
        bytes,
        sha256: hash.digest('hex'),
      });
    } catch (error) {
      await unlink(target).catch(() => {});
      throw error;
    }
  }
  async readText(key: string) {
    const bytes = await readFile(this.path(key));
    if (bytes.length > maxContentBytes)
      throw new Error('Stored file exceeds limit');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  }
  open(key: string) {
    return createReadStream(this.path(key));
  }
  async remove(key: string) {
    await unlink(this.path(key));
  }
}
