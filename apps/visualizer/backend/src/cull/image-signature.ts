/**
 * Which file Laya read, cheaply: `size:mtime`, stored with each stage answer so a later run can tell
 * whether it would read the same image.
 */
import { statSync } from 'node:fs';

/** Null when the file is gone. */
export function imageSignature(path: string): string | null {
  try {
    const st = statSync(path);
    return `${st.size}:${Math.trunc(st.mtimeMs)}`;
  } catch {
    return null;
  }
}
