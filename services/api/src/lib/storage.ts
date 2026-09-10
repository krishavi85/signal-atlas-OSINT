import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { loadEnv } from '../env.js';
import { logger } from '../logger.js';

/**
 * Object storage abstraction (§34). `local` writes under STORAGE_LOCAL_DIR;
 * `s3` is a documented interface point (an S3 adapter drops in here without
 * touching callers). Used for uploaded documents and evidence screenshots.
 */
export interface StoredObject {
  key: string;
  size: number;
  sha256: string;
}

export interface StorageDriver {
  put(prefix: string, data: Buffer, ext: string): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

class LocalStorage implements StorageDriver {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    const full = resolve(this.root, key);
    if (!full.startsWith(resolve(this.root))) throw new Error('path traversal blocked');
    return full;
  }

  async put(prefix: string, data: Buffer, ext: string): Promise<StoredObject> {
    const sha256 = createHash('sha256').update(data).digest('hex');
    const key = `${prefix}/${sha256.slice(0, 2)}/${randomUUID()}.${ext.replace(/^\./, '')}`;
    const dest = this.path(key);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, data);
    return { key, size: data.length, sha256 };
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

class S3NotConfigured implements StorageDriver {
  private fail(): never {
    throw new Error(
      'STORAGE_DRIVER=s3 selected but no S3 adapter is bundled in this build. Set STORAGE_DRIVER=local or add an S3 adapter in services/api/src/lib/storage.ts.',
    );
  }
  put = this.fail;
  get = this.fail;
  delete = this.fail;
}

let cached: StorageDriver | null = null;
export function storage(): StorageDriver {
  if (cached) return cached;
  const env = loadEnv();
  if (env.STORAGE_DRIVER === 's3') {
    logger.warn('STORAGE_DRIVER=s3 has no bundled adapter; file operations will fail until one is added.');
    cached = new S3NotConfigured();
  } else {
    cached = new LocalStorage(resolve(process.cwd(), env.STORAGE_LOCAL_DIR));
  }
  return cached;
}

export { join as joinKey };
