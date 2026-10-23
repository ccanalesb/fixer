/**
 * Which file Laya read, cheaply: `size:mtime`, stored with each stage answer so a later run can tell
 * whether it would read the same image.
 */
import { statSync } from 'node:fs';

/** Null when the file is gone, or was changed after `notAfterMs` (`cull-import`'s files). */
export function imageSignature(path: string, notAfterMs?: number): string | null {
  try {
    const st = statSync(path);
    if (notAfterMs !== undefined && st.mtimeMs > notAfterMs) return null;
    return `${st.size}:${Math.trunc(st.mtimeMs)}`;
  } catch {
    return null;
  }
}
