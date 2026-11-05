/**
 * One library per catalog under `<data folder>/catalogs/<name>/`.
 *
 * Each library records its catalog path and kind in `library_meta`. The app finds
 * the library by scanning each `catalogs/<name>/library.db`, not the other way around.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import {
  config,
  dataRoot,
  expandUserPath,
  loadLibraryConfig,
  pathBase,
  resolvePath,
  type LibraryConfig,
} from './config.js';
import { openLibraryDb, type Db } from './db/connection.js';
import {
  getLibraryMeta,
  initLibraryDb,
  setLibraryMeta,
} from './db/library/bootstrap.js';
import { libraryWrite } from './db/library/write.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { readFileSync } from 'node:fs';
import { writePrivateFile } from './utils/private-file.js';

export const CATALOG_PATH_META_KEY = 'catalog_path';
export const CATALOG_KIND_META_KEY = 'catalog_kind';

export type CatalogKind = 'lightroom' | 'folder';

export interface CatalogLibraryPaths {
  libraryDbPath: string;
  visionCacheDir: string;
  /** Label directory under `catalogs/`, when the library lives there. */
  catalogFolder: string | null;
}

export class CatalogLibraryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogLibraryConflictError';
  }
}

let legacyUpgradeDone = false;
let cachedCatalogPath: string | null | undefined;
let cachedResolution: CatalogLibraryPaths | null = null;
let cachedConflict: CatalogLibraryConflictError | null = null;

export function catalogsRoot(): string {
  return join(dataRoot(), 'catalogs');
}

/** Expand `~`, resolve relative paths, return an absolute catalog path. */
export function absoluteCatalogPath(raw: string, base = pathBase()): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return resolvePath(trimmed, base);
}

export function inferCatalogKind(catalogPath: string): CatalogKind {
  return catalogPath.toLowerCase().endsWith('.lrcat') ? 'lightroom' : 'folder';
}

export function isLibraryDbPinned(): boolean {
  return Boolean(process.env.LIBRARY_DB?.trim());
}

export function invalidateOpenLibraryCache(): void {
  cachedCatalogPath = undefined;
  cachedResolution = null;
  cachedConflict = null;
}

/** Test-only: allow repeated legacy upgrade scenarios in one process. */
export function resetCatalogLibraryModuleStateForTests(): void {
  legacyUpgradeDone = false;
  invalidateOpenLibraryCache();
}

function configuredCatalogAbsolute(configPath = config.LT_CONFIG_YAML): string | null {
  const cfg = loadLibraryConfig(configPath);
  const raw = cfg.catalogPathRaw.trim();
  if (!raw) return cfg.catalogPath;
  const abs = absoluteCatalogPath(raw);
  return abs || null;
}

function catalogFolderStem(catalogPath: string): string {
  let stem = basename(catalogPath.replace(/\/$/, ''));
  if (stem.toLowerCase().endsWith('.lrcat')) stem = stem.slice(0, -'.lrcat'.length);
  return stem || 'catalog';
}

export function generateCatalogFolderName(catalogPath: string): string {
  return `${catalogFolderStem(catalogPath)}-${randomBytes(2).toString('hex')}`;
}

function visionCacheBesideLibrary(libraryDbPath: string): string {
  return join(dirname(libraryDbPath), 'vision-cache');
}

export interface CatalogLibraryEntry {
  catalogFolder: string;
  libraryDbPath: string;
  visionCacheDir: string;
  catalogPath: string;
  catalogKind: CatalogKind;
}

function listCatalogLibraryDirs(): string[] {
  const root = catalogsRoot();
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const folder = join(root, name);
    try {
      if (!statSync(folder).isDirectory()) continue;
    } catch {
      continue;
    }
    const dbPath = join(folder, 'library.db');
    if (existsSync(dbPath) && statSync(dbPath).isFile()) out.push(folder);
  }
  return out;
}

function hasAnyCatalogLibrary(): boolean {
  return listCatalogLibraryDirs().length > 0;
}

function readCatalogLibraryEntry(catalogFolder: string): CatalogLibraryEntry | null {
  const libraryDbPath = join(catalogFolder, 'library.db');
  if (!existsSync(libraryDbPath)) return null;
  let db: Db | undefined;
  try {
    db = openLibraryDb(libraryDbPath, { readonly: true });
    const catalogPath = getLibraryMeta(db, CATALOG_PATH_META_KEY);
    if (!catalogPath) return null;
    const kindRaw = getLibraryMeta(db, CATALOG_KIND_META_KEY);
    const catalogKind: CatalogKind = kindRaw === 'folder' ? 'folder' : 'lightroom';
    return {
      catalogFolder,
      libraryDbPath,
      visionCacheDir: join(catalogFolder, 'vision-cache'),
      catalogPath,
      catalogKind,
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Every catalog library whose recorded path matches `catalogPath` (absolute). */
export function findCatalogLibrariesForPath(catalogPath: string): CatalogLibraryEntry[] {
  const target = absoluteCatalogPath(catalogPath);
  if (!target) return [];
  const matches: CatalogLibraryEntry[] = [];
  for (const folder of listCatalogLibraryDirs()) {
    const entry = readCatalogLibraryEntry(folder);
    if (!entry) continue;
    if (absoluteCatalogPath(entry.catalogPath) === target) matches.push(entry);
  }
  return matches;
}

function conflictMessage(entries: CatalogLibraryEntry[]): string {
  const names = entries.map((e) => e.catalogFolder);
  return (
    `Two libraries claim the same catalog path (${entries[0]!.catalogPath}): ` +
    names.join(' and ') +
    '.'
  );
}

function catalogFolderForLibraryDb(libraryDbPath: string): string | null {
  const parent = dirname(libraryDbPath);
  const root = catalogsRoot();
  if (parent === root || parent.startsWith(`${root}/`)) return parent;
  return null;
}

function resolvePinnedLibraryPaths(): CatalogLibraryPaths {
  const libraryDbPath = resolvePath(process.env.LIBRARY_DB!.trim(), pathBase());
  return {
    libraryDbPath,
    visionCacheDir: visionCacheBesideLibrary(libraryDbPath),
    catalogFolder: catalogFolderForLibraryDb(libraryDbPath),
  };
}

function legacyLibraryPath(cfg: LibraryConfig): string | null {
  if (cfg.dbPath && existsSync(cfg.dbPath) && statSync(cfg.dbPath).isFile()) {
    return cfg.dbPath;
  }
  const defaultPath = join(dataRoot(), 'library.db');
  if (existsSync(defaultPath) && statSync(defaultPath).isFile()) return defaultPath;
  const repoDefault = resolvePath('library.db', pathBase());
  if (existsSync(repoDefault) && statSync(repoDefault).isFile()) return repoDefault;
  return null;
}

function movePathCrossVolume(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  try {
    renameSync(src, dest);
  } catch (e) {
    const code = e && typeof e === 'object' && 'code' in e ? (e as NodeJS.ErrnoException).code : undefined;
    if (code !== 'EXDEV') throw e;
    cpSync(src, dest);
    rmSync(src, { force: true });
  }
}

/** After `library.db` moves, move `-wal` / `-shm` siblings when present. */
export function moveLibraryDbSidecarsIfPresent(fromLibrary: string, toLibrary: string): void {
  for (const suffix of ['-wal', '-shm'] as const) {
    const sidecar = `${fromLibrary}${suffix}`;
    if (existsSync(sidecar)) movePathCrossVolume(sidecar, `${toLibrary}${suffix}`);
  }
}

function moveDirectoryCrossVolume(src: string, dest: string): void {
  if (!existsSync(src)) {
    mkdirSync(dest, { recursive: true });
    return;
  }
  try {
    renameSync(src, dest);
  } catch (e) {
    const code = e && typeof e === 'object' && 'code' in e ? (e as NodeJS.ErrnoException).code : undefined;
    if (code !== 'EXDEV') throw e;
    cpSync(src, dest, { recursive: true });
    rmSync(src, { recursive: true, force: true });
  }
}

function checkpointWal(dbPath: string): void {
  const db = openLibraryDb(dbPath);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

function rewriteVisionCachePrefix(db: Db, oldPrefix: string, newPrefix: string): void {
  const normalizedOld = oldPrefix.endsWith('/') ? oldPrefix.slice(0, -1) : oldPrefix;
  const normalizedNew = newPrefix.endsWith('/') ? newPrefix.slice(0, -1) : newPrefix;
  const rows = db
    .prepare('SELECT key, compressed_path FROM vision_cache WHERE compressed_path IS NOT NULL')
    .all() as { key: string; compressed_path: string }[];
  const update = db.prepare('UPDATE vision_cache SET compressed_path = ? WHERE key = ?');
  for (const row of rows) {
    const path = row.compressed_path;
    if (path === normalizedOld || path.startsWith(`${normalizedOld}/`)) {
      update.run(`${normalizedNew}${path.slice(normalizedOld.length)}`, row.key);
    }
  }
}

export function removeRetiredKeysFromConfigYaml(configFile: string, keys: string[]): void {
  if (!existsSync(configFile)) return;
  const data = (parseYaml(readFileSync(configFile, 'utf8')) as Record<string, unknown>) ?? {};
  let changed = false;
  for (const key of keys) {
    if (key in data) {
      delete data[key];
      changed = true;
    }
  }
  if (changed) writePrivateFile(configFile, stringifyYaml(data, { lineWidth: 0 }));
}

export interface LegacyUpgradeResult {
  catalogFolder: string;
  libraryDbPath: string;
  visionCacheDir: string;
  fromLibraryPath: string;
  fromVisionCacheDir: string;
}

/**
 * When `catalogs/` has no library yet, move a legacy `library.db` and vision cache
 * into `catalogs/<name>/`. No-op when pinned, already migrated, or nothing to move.
 */
export function maybeUpgradeLegacyCatalogLayout(
  configPath = config.LT_CONFIG_YAML,
): LegacyUpgradeResult | null {
  if (isLibraryDbPinned()) return null;
  if (hasAnyCatalogLibrary()) return null;

  const cfg = loadLibraryConfig(configPath);
  const fromLibrary = legacyLibraryPath(cfg);
  if (!fromLibrary) return null;

  const catalogRaw = cfg.catalogPathRaw.trim();
  const catalogAbs = catalogRaw ? absoluteCatalogPath(catalogRaw) : cfg.catalogPath;
  if (!catalogAbs) return null;

  const folderName = generateCatalogFolderName(catalogAbs);
  const catalogFolder = join(catalogsRoot(), folderName);
  const libraryDbPath = join(catalogFolder, 'library.db');
  const visionCacheDir = join(catalogFolder, 'vision-cache');
  const fromVisionCache = cfg.visionCacheDir;

  mkdirSync(catalogFolder, { recursive: true });
  checkpointWal(fromLibrary);
  movePathCrossVolume(fromLibrary, libraryDbPath);
  moveLibraryDbSidecarsIfPresent(fromLibrary, libraryDbPath);
  moveDirectoryCrossVolume(fromVisionCache, visionCacheDir);

  const db = openLibraryDb(libraryDbPath);
  try {
    libraryWrite(db, () => {
      rewriteVisionCachePrefix(db, fromVisionCache, visionCacheDir);
      setLibraryMeta(db, CATALOG_PATH_META_KEY, catalogAbs);
      setLibraryMeta(db, CATALOG_KIND_META_KEY, inferCatalogKind(catalogAbs));
    });
  } finally {
    db.close();
  }

  removeRetiredKeysFromConfigYaml(configPath, ['db_path', 'vision_cache_dir']);
  invalidateOpenLibraryCache();

  return {
    catalogFolder,
    libraryDbPath,
    visionCacheDir,
    fromLibraryPath: fromLibrary,
    fromVisionCacheDir: fromVisionCache,
  };
}

export function runLegacyUpgradeOnce(configPath = config.LT_CONFIG_YAML): LegacyUpgradeResult | null {
  if (legacyUpgradeDone) return null;
  try {
    const result = maybeUpgradeLegacyCatalogLayout(configPath);
    legacyUpgradeDone = true;
    return result;
  } catch (e) {
    legacyUpgradeDone = false;
    throw e;
  }
}

/** Create `catalogs/<name>/` with a new library for a catalog that has none yet. */
export function createCatalogLibrary(catalogAbs: string): CatalogLibraryPaths {
  const folderName = generateCatalogFolderName(catalogAbs);
  const catalogFolder = join(catalogsRoot(), folderName);
  const libraryDbPath = join(catalogFolder, 'library.db');
  const visionCacheDir = join(catalogFolder, 'vision-cache');
  mkdirSync(visionCacheDir, { recursive: true });
  const db = initLibraryDb(libraryDbPath);
  try {
    libraryWrite(db, () => {
      setLibraryMeta(db, CATALOG_PATH_META_KEY, catalogAbs);
      setLibraryMeta(db, CATALOG_KIND_META_KEY, inferCatalogKind(catalogAbs));
    });
  } finally {
    db.close();
  }
  invalidateOpenLibraryCache();
  return { libraryDbPath, visionCacheDir, catalogFolder };
}

function resolveByCatalogLookup(configPath = config.LT_CONFIG_YAML): CatalogLibraryPaths {
  runLegacyUpgradeOnce(configPath);
  const catalogAbs = configuredCatalogAbsolute(configPath);
  if (!catalogAbs) {
    return {
      libraryDbPath: join(dataRoot(), 'library.db'),
      visionCacheDir: loadLibraryConfig(configPath).visionCacheDir,
      catalogFolder: null,
    };
  }

  const matches = findCatalogLibrariesForPath(catalogAbs);
  if (matches.length > 1) {
    throw new CatalogLibraryConflictError(conflictMessage(matches));
  }
  if (matches.length === 1) {
    const m = matches[0]!;
    return {
      libraryDbPath: m.libraryDbPath,
      visionCacheDir: m.visionCacheDir,
      catalogFolder: m.catalogFolder,
    };
  }

  return createCatalogLibrary(catalogAbs);
}

function resolveOpenLibraryInternal(configPath = config.LT_CONFIG_YAML): CatalogLibraryPaths {
  if (isLibraryDbPinned()) return resolvePinnedLibraryPaths();

  const catalogAbs = configuredCatalogAbsolute(configPath);
  if (cachedCatalogPath !== undefined && cachedCatalogPath === catalogAbs) {
    if (cachedConflict) throw cachedConflict;
    if (cachedResolution && catalogAbs) {
      const matches = findCatalogLibrariesForPath(catalogAbs);
      if (matches.length > 1) {
        cachedConflict = new CatalogLibraryConflictError(conflictMessage(matches));
        cachedResolution = null;
        throw cachedConflict;
      }
      if (matches.length === 1 && matches[0]!.libraryDbPath === cachedResolution.libraryDbPath) {
        return cachedResolution;
      }
    } else if (cachedResolution && !catalogAbs) {
      return cachedResolution;
    }
  }

  cachedCatalogPath = catalogAbs;
  cachedConflict = null;
  try {
    cachedResolution = resolveByCatalogLookup(configPath);
    return cachedResolution;
  } catch (e) {
    if (e instanceof CatalogLibraryConflictError) {
      cachedConflict = e;
      cachedResolution = null;
    }
    throw e;
  }
}

export function resolveCatalogLibraryPaths(configPath = config.LT_CONFIG_YAML): CatalogLibraryPaths {
  return resolveOpenLibraryInternal(configPath);
}

/** Catalog path recorded in the pinned library, or `null`. */
export function pinnedLibraryCatalogPath(): string | null {
  if (!isLibraryDbPinned()) return null;
  const { libraryDbPath } = resolvePinnedLibraryPaths();
  if (!existsSync(libraryDbPath)) return null;
  let db: Db | undefined;
  try {
    db = openLibraryDb(libraryDbPath, { readonly: true });
    return getLibraryMeta(db, CATALOG_PATH_META_KEY);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Update the pinned library's recorded catalog path (same catalog, new path). */
export function updatePinnedLibraryCatalogPath(catalogAbs: string): void {
  const { libraryDbPath } = resolvePinnedLibraryPaths();
  const db = openLibraryDb(libraryDbPath);
  try {
    libraryWrite(db, () => {
      setLibraryMeta(db, CATALOG_PATH_META_KEY, catalogAbs);
      setLibraryMeta(db, CATALOG_KIND_META_KEY, inferCatalogKind(catalogAbs));
    });
  } finally {
    db.close();
  }
}
