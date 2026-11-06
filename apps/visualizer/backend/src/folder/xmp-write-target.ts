/**
 * Where folder-catalog write-back writes rating metadata.
 */
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { RAW_EXTENSIONS } from '../imaging/raw-decode.js';
import { sidecarPathsForFile } from './xmp-sidecars.js';
import type { ResolvedFolderPhoto } from './walk.js';

export type FolderWriteTargetKind = 'new_sidecar' | 'update_sidecar' | 'embedded';

export interface FolderWriteTarget {
  path: string;
  kind: FolderWriteTargetKind;
}

export function resolveFolderWriteTargets(
  photo: ResolvedFolderPhoto,
  ambiguousStemSidecarDirs: ReadonlySet<string>,
): FolderWriteTarget[] {
  const ext = extname(photo.filepath).toLowerCase();
  const isRaw = RAW_EXTENSIONS.has(ext);
  const sidecars = sidecarPathsForFile(photo.filepath, photo.stem, ambiguousStemSidecarDirs).filter((p) =>
    existsSync(p),
  );

  if (isRaw) {
    if (sidecars.length) {
      return sidecars.map((path) => ({ path, kind: 'update_sidecar' as const }));
    }
    return [{ path: join(dirname(photo.filepath), `${photo.stem}.xmp`), kind: 'new_sidecar' }];
  }

  if (sidecars.length) {
    return sidecars.map((path) => ({ path, kind: 'update_sidecar' as const }));
  }
  return [{ path: photo.filepath, kind: 'embedded' }];
}

export function dryRunBreakdownForTargets(targets: readonly FolderWriteTarget[]): {
  new_sidecar: number;
  update_sidecar: number;
  embedded: number;
} {
  let new_sidecar = 0;
  let update_sidecar = 0;
  let embedded = 0;
  for (const t of targets) {
    if (t.kind === 'new_sidecar') new_sidecar += 1;
    else if (t.kind === 'update_sidecar') update_sidecar += 1;
    else embedded += 1;
  }
  return { new_sidecar, update_sidecar, embedded };
}
