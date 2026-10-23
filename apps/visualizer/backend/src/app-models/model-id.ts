/**
 * Which model answered: part of every stage version, so answers from another model are never read as
 * current.
 *
 * A model from Hugging Face is its id and commit (`model.json`). A model from a folder has no revision,
 * so it is named by the SHA-256 of its exported decoder — a retrain written to the same folder still
 * makes a new version. Hashing 433 MB takes a few seconds, so the hash is kept beside the file, keyed
 * by its size and mtime.
 */
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InstalledModel } from './files.js';

const HASH_CACHE = 'decoder.onnx.sha256.json';

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** `<name>@sha256:<decoder hash>`. */
async function decoderModelId(dir: string, name: string): Promise<string> {
  const decoder = join(dir, 'decoder.onnx');
  const { size, mtimeMs } = statSync(decoder);
  const cachePath = join(dir, HASH_CACHE);
  try {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as { size: number; mtimeMs: number; sha256: string };
    if (cached.size === size && cached.mtimeMs === mtimeMs) return `${name}@sha256:${cached.sha256}`;
  } catch {
    // No cache yet, or unreadable: hash it.
  }
  const sha256 = await sha256File(decoder);
  try {
    writeFileSync(cachePath, JSON.stringify({ size, mtimeMs, sha256 }));
  } catch {
    // A read-only models directory only costs the hash again next time.
  }
  return `${name}@sha256:${sha256}`;
}

export async function installedModelId(m: InstalledModel): Promise<string> {
  return m.source && m.revision ? `${m.source}@${m.revision}` : decoderModelId(m.dir, m.name);
}