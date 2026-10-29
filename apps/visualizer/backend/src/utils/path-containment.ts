import path from 'node:path';

export type PathContainmentModule = Pick<typeof path, 'relative' | 'isAbsolute' | 'resolve'>;

/** Whether `resolvedTarget` is `resolvedBase` or a path beneath it (both already resolved). */
export function isResolvedPathInsideDir(
  resolvedBase: string,
  resolvedTarget: string,
  pathMod: PathContainmentModule = path,
): boolean {
  const base = pathMod.resolve(resolvedBase);
  const target = pathMod.resolve(resolvedTarget);
  if (target === base) return true;
  const rel = pathMod.relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !pathMod.isAbsolute(rel);
}
