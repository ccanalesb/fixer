/**
 * Atomic file replace under a folder catalog root.
 */
import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, extname, join } from 'node:path';
import { pathUnderCatalogRoot } from './path-under-root.js';

export type AtomicWriteOutcome = 'ok' | 'skipped_mtime' | 'readonly' | 'outside';

export interface MtimeGuard {
  path: string;
  mtimeMs: number;
}

export function snapshotMtime(path: string): MtimeGuard | null {
  try {
    const st = statSync(path);
    return { path, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

export function mtimeMatches(guard: MtimeGuard): boolean {
  try {
    return statSync(guard.path).mtimeMs === guard.mtimeMs;
  } catch {
    return false;
  }
}

function isReadonlyError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

function isUnderRoot(catalogRoot: string, filePath: string): boolean {
  return pathUnderCatalogRoot(catalogRoot, filePath);
}

export async function atomicReplaceFileAsync(
  catalogRoot: string,
  destPath: string,
  guards: readonly MtimeGuard[],
  prepare: (tempPath: string) => Promise<void>,
): Promise<AtomicWriteOutcome> {
  if (!isUnderRoot(catalogRoot, destPath)) return 'outside';
  for (const g of guards) {
    if (!mtimeMatches(g)) return 'skipped_mtime';
  }

  const dir = dirname(destPath);
  const ext = extname(destPath) || '.tmp';
  const tempPath = join(dir, `.fixer-${randomUUID()}${ext}`);
  if (!isUnderRoot(catalogRoot, tempPath)) return 'outside';

  try {
    if (existsSync(destPath)) {
      copyFileSync(destPath, tempPath);
    }
    await prepare(tempPath);
    const fd = openSync(tempPath, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    for (const g of guards) {
      if (!mtimeMatches(g)) {
        unlinkSync(tempPath);
        return 'skipped_mtime';
      }
    }
    renameSync(tempPath, destPath);
    return 'ok';
  } catch (e) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      /* ignore */
    }
    if (isReadonlyError(e)) return 'readonly';
    throw e;
  }
}
