/**
 * Which model answered: part of every stage version, so answers from another model are never read as
 * current.
 *
 * Laya base is a Hugging Face revision (`model.json`). Laya new is a local checkpoint with no revision,
 * so it is named by the SHA-256 of its exported decoder — a retrain written to the same path still
 * makes a new version. Hashing 433 MB takes a few seconds, so the hash is kept beside the file, keyed
 * by its size and mtime.
 */
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LayaModelFiles } from './files.js';

/** The Laya base the research runs and the setup step use (`thaitea/laya-vision` at `8b318c9`). */
export const LAYA_BASE_RESEARCH_MODEL_ID = 'thaitea/laya-vision@8b318c99d7ad3ce19c24369263463882eada9d1e';

const HASH_CACHE = 'decoder.onnx.sha256.json';

export function layaBaseModelId(baseDir: string): string {
  const meta = JSON.parse(readFileSync(join(baseDir, 'model.json'), 'utf8')) as { source?: string; revision?: string | null };
  return `${meta.source ?? 'unknown'}@${meta.revision ?? 'unknown'}`;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function layaNewModelId(newDir: string): Promise<string> {
  const decoder = join(newDir, 'decoder.onnx');
  const { size, mtimeMs } = statSync(decoder);
  const cachePath = join(newDir, HASH_CACHE);
  try {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as { size: number; mtimeMs: number; sha256: string };
    if (cached.size === size && cached.mtimeMs === mtimeMs) return `laya-new@sha256:${cached.sha256}`;
  } catch {
    // No cache yet, or unreadable: hash it.
  }
  const sha256 = await sha256File(decoder);
  try {
    writeFileSync(cachePath, JSON.stringify({ size, mtimeMs, sha256 }));
  } catch {
    // A read-only models directory only costs the hash again next time.
  }
  return `laya-new@sha256:${sha256}`;
}

/** Each model's identity; `new` is null when Laya new is not set up. */
export interface LayaModelIds {
  base: string;
  new: string | null;
}

export async function readLayaModelIds(files: LayaModelFiles): Promise<LayaModelIds> {
  return {
    base: layaBaseModelId(files.baseDir),
    new: files.newDir ? await layaNewModelId(files.newDir) : null,
  };
}
