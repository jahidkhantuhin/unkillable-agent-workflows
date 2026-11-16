import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { it, expect } from 'vitest';
import { LocalContentStorage } from './content-files';
it('streams UTF-8 files and removes partial empty, invalid and oversized uploads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'unkillable-content-'));
  const files = new LocalContentStorage(root);
  try {
    const saved = await files.put(Readable.from(['Hello ', 'community']));
    expect(saved.bytes).toBe(15);
    expect(await files.readText(saved.key)).toBe('Hello community');
    await expect(files.readText('../.env')).rejects.toThrow(
      'Invalid content storage key',
    );
    await expect(files.put(Readable.from([]))).rejects.toThrow('empty');
    await expect(
      files.put(Readable.from([Buffer.from([0xff])])),
    ).rejects.toThrow('UTF-8');
    await expect(
      files.put(Readable.from([Buffer.alloc(10 * 1024 * 1024 + 1, 'x')])),
    ).rejects.toThrow('10 MiB');
    expect(await readdir(root)).toEqual([saved.key]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
