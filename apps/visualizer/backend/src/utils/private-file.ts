import { chmodSync, writeFileSync } from 'node:fs';

/** Write a user-owned secret file with restrictive permissions on Unix. */
export function writePrivateFile(path: string, content: string): void {
  writeFileSync(path, content, 'utf8');
  if (process.platform !== 'win32') {
    chmodSync(path, 0o600);
  }
}
