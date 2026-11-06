/**
 * Parallel `lstat` for folder catalog sync.
 */
import { lstat } from 'node:fs/promises';

export interface FileStatSnapshot {
  size: number;
  mtimeMs: number;
  readable: boolean;
}

export async function lstatPathsParallel(
  paths: readonly string[],
  concurrency = 32,
): Promise<Map<string, FileStatSnapshot>> {
  const out = new Map<string, FileStatSnapshot>();
  let index = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = index;
      index += 1;
      if (i >= paths.length) return;
      const path = paths[i]!;
      try {
        const st = await lstat(path);
        out.set(path, { size: st.size, mtimeMs: st.mtimeMs, readable: true });
      } catch {
        out.set(path, { size: 0, mtimeMs: 0, readable: false });
      }
    }
  }
  const workers = Math.min(concurrency, paths.length || 1);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}
