/**
 * Resolve catalog file paths recorded as UNC/network locations.
 *
 * Lightroom stores NAS paths as `//tnas/ccanales/Foo/bar.jpg`, which no local API
 * can open. On macOS the same share appears under `/Volumes/<share>`, sometimes with
 * a `-1` suffix when it was mounted twice. Resolution is therefore a search, not a
 * rewrite, and it can legitimately fail — the caller must handle the empty result
 * rather than assume a path came back.
 */
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Whether `path` is a mount point.
 *
 * A non-symlink whose device differs from its parent, or whose inode equals its
 * parent's (root).
 */
function isMount(path: string): boolean {
  let s1;
  try {
    s1 = lstatSync(path);
  } catch {
    return false;
  }
  if (s1.isSymbolicLink()) return false;

  let s2;
  try {
    s2 = lstatSync(join(path, '..'));
  } catch {
    return false;
  }
  if (s1.dev !== s2.dev) return true;
  return s1.ino === s2.ino;
}

/**
 * Map a `//server/share/rest` path onto a local mount point.
 *
 * `NAS_PATH_PREFIX` and `NAS_MOUNT_POINT` configure it explicitly; otherwise
 * `/Volumes` is scanned for a mount whose name starts with the share name, newest
 * suffix first. Anything that is not a UNC path is returned untouched.
 *
 * When nothing resolves, the configured path is returned even though it does not
 * exist — and failing that, the original `//...` string. Both are indistinguishable
 * from success by inspection, so callers must test the result for existence.
 */
export function resolveFilepath(path: string): string {
  if (!path || !path.startsWith('//')) return path;

  const prefix = process.env.NAS_PATH_PREFIX ?? '';
  const mount = process.env.NAS_MOUNT_POINT ?? '';

  // `//server/share/rest/of/path` → at most three pieces; the remainder stays whole.
  const parts = path.replace(/^\/+/, '').split('/');
  if (parts.length < 2) return path;
  const shareName = parts[1]!;
  const restOfPath = parts.slice(2).join('/');

  const configuredTarget = (): string | null => {
    if (!prefix || !mount) return null;
    const prefixParts = prefix.replace(/^\/+/, '').split('/');
    if (prefixParts.length >= 2 && prefixParts[1] === shareName) {
      return restOfPath ? join(mount, restOfPath) : mount;
    }
    return null;
  };

  const configured = configuredTarget();
  if (configured && existsSync(configured)) return configured;

  try {
    // Reverse sort so `ccanales-1` (newer duplicate mount) is preferred over `ccanales`.
    for (const name of readdirSync('/Volumes').sort().reverse()) {
      if (!name.startsWith(shareName)) continue;
      const candidate = join('/Volumes', name);
      if (!isMount(candidate)) continue;
      const resolved = restOfPath ? join(candidate, restOfPath) : candidate;
      if (existsSync(resolved)) return resolved;
    }
  } catch {
    // No /Volumes (a non-macOS host): fall through to the configured path.
  }

  return configured ?? path;
}

/**
 * Resolve a stored catalog image filepath to something openable, or `''` when it cannot be reached.
 *
 * An existing path is returned as-is; otherwise UNC resolution is attempted and the
 * result is only accepted if it exists. The empty string is the "unreachable"
 * signal, which is why a caller must never pass this straight to a file API.
 */
export function resolveCatalogImageFilePath(filepath: string): string {
  if (!filepath) return '';
  if (existsSync(filepath)) return filepath;

  const resolved = resolveFilepath(filepath);
  if (resolved !== filepath && existsSync(resolved)) return resolved;

  return '';
}
