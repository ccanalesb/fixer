/**
 * Atomic file replace under a folder catalog root.
 */
import { statSync } from 'node:fs';
import { access, constants, copyFile, open, rename, stat, unlink } from 'node:fs/promises';
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

async function mtimeMatches(guard: MtimeGuard): Promise<boolean> {
  try {
    return (await stat(guard.path)).mtimeMs === guard.mtimeMs;
  } catch {
    return false;
  }
}

async function guardsHold(guards: readonly MtimeGuard[]): Promise<boolean> {
  for (const g of guards) {
    if (!(await mtimeMatches(g))) return false;
  }
  return true;
}

function isReadonlyError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `destPath` can be replaced right now: under the root, guards unchanged,
 * and both the file (when it exists) and its folder writable. A read-only file
 * counts as read-only even though a rename could still replace it.
 */
export async function checkAtomicReplace(
  catalogRoot: string,
  destPath: string,
  guards: readonly MtimeGuard[],
): Promise<AtomicWriteOutcome> {
  if (!pathUnderCatalogRoot(catalogRoot, destPath)) return 'outside';
  if (!(await guardsHold(guards))) return 'skipped_mtime';
  if (!(await writable(dirname(destPath)))) return 'readonly';
  if ((await fileExists(destPath)) && !(await writable(destPath))) return 'readonly';
  return 'ok';
}

/** Make the rename durable; directories cannot be opened for fsync on Windows. */
async function fsyncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // The rename has already happened; a filesystem that cannot fsync a folder keeps it anyway.
  }
}

export async function atomicReplaceFileAsync(
  catalogRoot: string,
  destPath: string,
  guards: readonly MtimeGuard[],
  prepare: (tempPath: string) => Promise<void>,
): Promise<AtomicWriteOutcome> {
  const ready = await checkAtomicReplace(catalogRoot, destPath, guards);
  if (ready !== 'ok') return ready;

  const dir = dirname(destPath);
  const ext = extname(destPath) || '.tmp';
  const tempPath = join(dir, `.fixer-${randomUUID()}${ext}`);
  if (!pathUnderCatalogRoot(catalogRoot, tempPath)) return 'outside';

  try {
    if (await fileExists(destPath)) {
      await copyFile(destPath, tempPath);
    }
    await prepare(tempPath);
    const handle = await open(tempPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!(await guardsHold(guards))) {
      await unlink(tempPath);
      return 'skipped_mtime';
    }
    await rename(tempPath, destPath);
    await fsyncDir(dir);
    return 'ok';
  } catch (e) {
    await unlink(tempPath).catch(() => {});
    if (isReadonlyError(e)) return 'readonly';
    throw e;
  }
}
