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
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  config,
  dataRoot,
  loadLibraryConfig,
  pathBase,
  resolvePath,
  type LibraryConfig,
} from './config.js';
import { openLibraryDb, type Db } from './db/connection.js';
import {
  deleteLibraryMeta,
  getLibraryMeta,
  initLibraryDb,
  setLibraryMeta,
} from './db/library/bootstrap.js';
import { libraryWrite } from './db/library/write.js';
import { writePrivateFile } from './utils/private-file.js';

export const CATALOG_PATH_META_KEY = 'catalog_path';
export const CATALOG_KIND_META_KEY = 'catalog_kind';
/**
 * Set while a legacy library is being moved into `catalogs/`: JSON
 * `{ fromLibrary, fromVisionCache }`. Written before the move and removed once the
 * vision cache has followed, so an interrupted upgrade resumes on the next start.
 */
const LEGACY_UPGRADE_META_KEY = 'legacy_upgrade';

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

interface LookupCache {
  /** Data folder, config file and its last write; any change means a new lookup. */
  key: string;
  result: CatalogLibraryPaths | CatalogLibraryConflictError;
}

let legacyUpgradeDone = false;
let lookupCache: LookupCache | null = null;

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
  lookupCache = null;
}

/** Test-only: allow repeated legacy upgrade scenarios in one process. */
export function resetCatalogLibraryModuleStateForTests(): void {
  legacyUpgradeDone = false;
  invalidateOpenLibraryCache();
}

/** `config.yaml`'s `catalog_path`, absolute, or `null` when unset. */
export function catalogPathFromConfig(cfg: LibraryConfig): string | null {
  const raw = cfg.catalogPathRaw.trim();
  if (!raw) return cfg.catalogPath;
  return absoluteCatalogPath(raw) || null;
}

/** Record which catalog a library belongs to: its absolute path and kind. */
export function recordCatalog(db: Db, catalogAbs: string): void {
  libraryWrite(db, () => {
    setLibraryMeta(db, CATALOG_PATH_META_KEY, catalogAbs);
    setLibraryMeta(db, CATALOG_KIND_META_KEY, inferCatalogKind(catalogAbs));
  });
}

/** `recordCatalog` on the library at `libraryDbPath`. */
export function recordCatalogAt(libraryDbPath: string, catalogAbs: string): void {
  const db = openLibraryDb(libraryDbPath);
  try {
    recordCatalog(db, catalogAbs);
  } finally {
    db.close();
  }
}

/** The catalog path a library records, or `null` when it records none or cannot be read. */
export function readRecordedCatalogPath(libraryDbPath: string): string | null {
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

function catalogFolderForLibraryDb(libraryDbPath: string): string | null {
  const parent = dirname(libraryDbPath);
  const root = catalogsRoot();
  if (parent === root || parent.startsWith(`${root}/`)) return parent;
  return null;
}

/** The library at `libraryDbPath` and the vision cache beside it — what a pin opens. */
export function libraryPathsAt(libraryDbPath: string): CatalogLibraryPaths {
  return {
    libraryDbPath,
    visionCacheDir: visionCacheBesideLibrary(libraryDbPath),
    catalogFolder: catalogFolderForLibraryDb(libraryDbPath),
  };
}

function pinnedLibraryPaths(): CatalogLibraryPaths {
  return libraryPathsAt(resolvePath(process.env.LIBRARY_DB!.trim(), pathBase()));
}

export interface CatalogLibraryEntry {
  catalogFolder: string;
  libraryDbPath: string;
  visionCacheDir: string;
  catalogPath: string;
  catalogKind: CatalogKind;
}

interface ListedLibrary extends CatalogLibraryEntry {
  /** `LEGACY_UPGRADE_META_KEY`'s value while an upgrade into this library is unfinished. */
  pendingUpgrade: string | null;
}

function listCatalogLibraryDirs(): string[] {
  const root = catalogsRoot();
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const folder = join(root, name);
    try {
      if (!statSync(folder).isDirectory()) continue;
      if (statSync(join(folder, 'library.db')).isFile()) out.push(folder);
    } catch {
      continue;
    }
  }
  return out;
}

/** A library under `catalogs/` that records its catalog; any other is not one the app opens. */
function readCatalogLibrary(catalogFolder: string): ListedLibrary | null {
  const libraryDbPath = join(catalogFolder, 'library.db');
  let db: Db | undefined;
  try {
    db = openLibraryDb(libraryDbPath, { readonly: true });
    const catalogPath = getLibraryMeta(db, CATALOG_PATH_META_KEY);
    if (!catalogPath) return null;
    const catalogKind: CatalogKind =
      getLibraryMeta(db, CATALOG_KIND_META_KEY) === 'folder' ? 'folder' : 'lightroom';
    return {
      catalogFolder,
      libraryDbPath,
      visionCacheDir: visionCacheBesideLibrary(libraryDbPath),
      catalogPath,
      catalogKind,
      pendingUpgrade: getLibraryMeta(db, LEGACY_UPGRADE_META_KEY),
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function listCatalogLibraries(): ListedLibrary[] {
  return listCatalogLibraryDirs()
    .map(readCatalogLibrary)
    .filter((e): e is ListedLibrary => e !== null);
}

/** Every catalog library whose recorded path matches `catalogPath` (absolute). */
export function findCatalogLibrariesForPath(catalogPath: string): CatalogLibraryEntry[] {
  const target = absoluteCatalogPath(catalogPath);
  if (!target) return [];
  return listCatalogLibraries()
    .filter((e) => absoluteCatalogPath(e.catalogPath) === target)
    .map(({ pendingUpgrade: _pending, ...entry }) => entry);
}

/**
 * The library that records `catalogAbs`, or `null` when none does.
 *
 * @throws CatalogLibraryConflictError when two libraries claim it.
 */
export function findCatalogLibrary(catalogAbs: string): CatalogLibraryPaths | null {
  const matches = findCatalogLibrariesForPath(catalogAbs);
  if (matches.length > 1) {
    throw new CatalogLibraryConflictError(
      `Two libraries claim the same catalog path (${matches[0]!.catalogPath}): ` +
        `${matches.map((e) => e.catalogFolder).join(' and ')}.`,
    );
  }
  const m = matches[0];
  return m ? { libraryDbPath: m.libraryDbPath, visionCacheDir: m.visionCacheDir, catalogFolder: m.catalogFolder } : null;
}

function legacyLibraryPath(cfg: LibraryConfig): string | null {
  for (const candidate of [cfg.dbPath, join(dataRoot(), 'library.db')]) {
    if (candidate && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** The filesystem moves an upgrade makes; tests replace them to interrupt one or cross volumes. */
export interface UpgradeFs {
  rename(src: string, dest: string): void;
  /** Copy a file, or a directory recursively, merging into one that exists. */
  copy(src: string, dest: string): void;
}

const realUpgradeFs: UpgradeFs = {
  rename: renameSync,
  copy: (src, dest) => cpSync(src, dest, { recursive: true }),
};

function isCrossDevice(e: unknown): boolean {
  return Boolean(e && typeof e === 'object' && (e as NodeJS.ErrnoException).code === 'EXDEV');
}

/** Size of every file under `path`, keyed by its path relative to `path` (`''` for a file). */
function fileSizes(path: string): Map<string, number> {
  const sizes = new Map<string, number>();
  const walk = (abs: string, rel: string): void => {
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const name of readdirSync(abs)) walk(join(abs, name), rel ? `${rel}/${name}` : name);
    } else if (st.isFile()) {
      sizes.set(rel, st.size);
    }
  };
  walk(path, '');
  return sizes;
}

/** Throw unless every file under `src` is at `copy` with the same size. */
function assertCopiedWhole(src: string, copy: string, dest: string): void {
  const copied = existsSync(copy) ? fileSizes(copy) : new Map<string, number>();
  for (const [rel, size] of fileSizes(src)) {
    if (copied.get(rel) !== size) {
      throw new Error(`Copying ${src} to ${dest} came out incomplete; ${src} is kept.`);
    }
  }
}

/** Copy `src` into `dest`, check every file arrived whole, and only then remove `src`. */
function copyThenRemove(src: string, dest: string, fs: UpgradeFs): void {
  fs.copy(src, dest);
  assertCopiedWhole(src, dest, dest);
  rmSync(src, { recursive: true, force: true });
}

/**
 * Move a file or directory to a `dest` that does not exist yet. Across volumes it is
 * copied beside `dest`, checked, renamed into place, and the original removed last.
 */
function movePath(src: string, dest: string, fs: UpgradeFs): void {
  mkdirSync(dirname(dest), { recursive: true });
  try {
    fs.rename(src, dest);
    return;
  } catch (e) {
    if (!isCrossDevice(e)) throw e;
  }
  const partial = `${dest}.partial`;
  rmSync(partial, { recursive: true, force: true });
  try {
    fs.copy(src, partial);
    assertCopiedWhole(src, partial, dest);
  } catch (e) {
    rmSync(partial, { recursive: true, force: true });
    throw e;
  }
  renameSync(partial, dest);
  rmSync(src, { recursive: true, force: true });
}

/** After `library.db` moves, move `-wal` / `-shm` siblings when present. */
export function moveLibraryDbSidecarsIfPresent(
  fromLibrary: string,
  toLibrary: string,
  fs: UpgradeFs = realUpgradeFs,
): void {
  for (const suffix of ['-wal', '-shm'] as const) {
    const sidecar = `${fromLibrary}${suffix}`;
    if (existsSync(sidecar)) movePath(sidecar, `${toLibrary}${suffix}`, fs);
  }
}

/** Move the legacy vision cache to `dest`, merging into it when a resumed upgrade finds it started. */
function moveVisionCache(src: string, dest: string, fs: UpgradeFs): void {
  if (!existsSync(src)) {
    mkdirSync(dest, { recursive: true });
    return;
  }
  if (!existsSync(dest)) {
    movePath(src, dest, fs);
    return;
  }
  copyThenRemove(src, dest, fs);
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

interface PendingUpgrade {
  fromLibrary: string;
  fromVisionCache: string;
}

/** What an upgrade moved, one line each, as the server log and the CLI print it. */
export function legacyUpgradeLines(result: LegacyUpgradeResult): string[] {
  return [
    `Moved library.db from ${result.fromLibraryPath} to ${result.libraryDbPath}`,
    `Moved vision cache from ${result.fromVisionCacheDir} to ${result.visionCacheDir}`,
  ];
}

/**
 * The second half of an upgrade, once the library sits in `catalogs/<name>/`. Every
 * step can run again, so an interrupted upgrade finishes here on the next start.
 */
function finishLegacyUpgrade(
  libraryDbPath: string,
  pending: PendingUpgrade,
  configPath: string,
  fs: UpgradeFs,
): LegacyUpgradeResult {
  const visionCacheDir = visionCacheBesideLibrary(libraryDbPath);
  moveVisionCache(pending.fromVisionCache, visionCacheDir, fs);
  removeRetiredKeysFromConfigYaml(configPath, ['db_path', 'vision_cache_dir']);
  const db = openLibraryDb(libraryDbPath);
  try {
    libraryWrite(db, () => {
      rewriteVisionCachePrefix(db, pending.fromVisionCache, visionCacheDir);
      deleteLibraryMeta(db, LEGACY_UPGRADE_META_KEY);
    });
  } finally {
    db.close();
  }
  invalidateOpenLibraryCache();
  return {
    catalogFolder: dirname(libraryDbPath),
    libraryDbPath,
    visionCacheDir,
    fromLibraryPath: pending.fromLibrary,
    fromVisionCacheDir: pending.fromVisionCache,
  };
}

/**
 * When `catalogs/` has no library yet, move a legacy `library.db` and vision cache
 * into `catalogs/<name>/`, or finish such a move that was interrupted. No-op when
 * pinned, already migrated, or nothing to move.
 *
 * The catalog is recorded in the legacy library before it moves, so whatever stops
 * the upgrade, the next start finds the user's library rather than creating an empty one.
 */
export function maybeUpgradeLegacyCatalogLayout(
  configPath = config.LT_CONFIG_YAML,
  fs: UpgradeFs = realUpgradeFs,
): LegacyUpgradeResult | null {
  if (isLibraryDbPinned()) return null;
  const libraries = listCatalogLibraries();
  const interrupted = libraries.find((e) => e.pendingUpgrade);
  if (interrupted) {
    const pending = JSON.parse(interrupted.pendingUpgrade!) as PendingUpgrade;
    return finishLegacyUpgrade(interrupted.libraryDbPath, pending, configPath, fs);
  }
  if (libraries.length > 0) return null;

  const cfg = loadLibraryConfig(configPath);
  const fromLibrary = legacyLibraryPath(cfg);
  if (!fromLibrary) return null;
  const catalogAbs = catalogPathFromConfig(cfg);
  if (!catalogAbs) return null;
  const pending: PendingUpgrade = { fromLibrary, fromVisionCache: cfg.visionCacheDir };

  const legacy = openLibraryDb(fromLibrary);
  try {
    libraryWrite(legacy, () => {
      recordCatalog(legacy, catalogAbs);
      setLibraryMeta(legacy, LEGACY_UPGRADE_META_KEY, JSON.stringify(pending));
    });
    legacy.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    legacy.close();
  }

  const catalogFolder = join(catalogsRoot(), generateCatalogFolderName(catalogAbs));
  const libraryDbPath = join(catalogFolder, 'library.db');
  mkdirSync(catalogFolder, { recursive: true });
  try {
    movePath(fromLibrary, libraryDbPath, fs);
  } catch (e) {
    rmSync(catalogFolder, { recursive: true, force: true });
    throw e;
  }
  moveLibraryDbSidecarsIfPresent(fromLibrary, libraryDbPath, fs);
  return finishLegacyUpgrade(libraryDbPath, pending, configPath, fs);
}

export function runLegacyUpgradeOnce(configPath = config.LT_CONFIG_YAML): LegacyUpgradeResult | null {
  if (legacyUpgradeDone) return null;
  const result = maybeUpgradeLegacyCatalogLayout(configPath);
  legacyUpgradeDone = true;
  return result;
}

/** Startup's explanation when the upgrade fails: what failed, and that nothing is lost. */
export function legacyUpgradeFailureMessage(e: unknown): string {
  const reason = e instanceof Error ? e.message : String(e);
  return (
    `Could not move the library into ${catalogsRoot()}: ${reason}\n` +
    'Your library and its previews are kept where they are; the move resumes on the next start.'
  );
}

/** Create `catalogs/<name>/` with a new library for a catalog that has none yet. */
export function createCatalogLibrary(catalogAbs: string): CatalogLibraryPaths {
  const catalogFolder = join(catalogsRoot(), generateCatalogFolderName(catalogAbs));
  const libraryDbPath = join(catalogFolder, 'library.db');
  const visionCacheDir = visionCacheBesideLibrary(libraryDbPath);
  mkdirSync(visionCacheDir, { recursive: true });
  const db = initLibraryDb(libraryDbPath);
  try {
    recordCatalog(db, catalogAbs);
  } finally {
    db.close();
  }
  invalidateOpenLibraryCache();
  return { libraryDbPath, visionCacheDir, catalogFolder };
}

function resolveByCatalogLookup(configPath: string): CatalogLibraryPaths {
  runLegacyUpgradeOnce(configPath);
  const cfg = loadLibraryConfig(configPath);
  const catalogAbs = catalogPathFromConfig(cfg);
  if (!catalogAbs) {
    return {
      libraryDbPath: join(dataRoot(), 'library.db'),
      visionCacheDir: cfg.visionCacheDir,
      catalogFolder: null,
    };
  }
  return findCatalogLibrary(catalogAbs) ?? createCatalogLibrary(catalogAbs);
}

function lookupCacheKey(configPath: string): string {
  let written = 'absent';
  try {
    const st = statSync(configPath);
    written = `${st.mtimeMs}:${st.size}`;
  } catch {
    // No config file yet: the key still changes once one is written.
  }
  return `${catalogsRoot()}\n${configPath}\n${written}`;
}

/**
 * `LIBRARY_DB` when set, else the library under `catalogs/` whose recorded path
 * matches `catalog_path`. The answer is kept until `config.yaml` or the data folder
 * changes, or `invalidateOpenLibraryCache()` is called.
 */
export function resolveCatalogLibraryPaths(configPath = config.LT_CONFIG_YAML): CatalogLibraryPaths {
  if (isLibraryDbPinned()) return pinnedLibraryPaths();

  const cached = lookupCache;
  if (cached && cached.key === lookupCacheKey(configPath)) {
    if (cached.result instanceof CatalogLibraryConflictError) throw cached.result;
    if (!cached.result.catalogFolder || existsSync(cached.result.libraryDbPath)) return cached.result;
  }

  try {
    const result = resolveByCatalogLookup(configPath);
    lookupCache = { key: lookupCacheKey(configPath), result };
    return result;
  } catch (e) {
    if (e instanceof CatalogLibraryConflictError) {
      lookupCache = { key: lookupCacheKey(configPath), result: e };
    }
    throw e;
  }
}

/** Catalog path recorded in the pinned library, or `null`. */
export function pinnedLibraryCatalogPath(): string | null {
  if (!isLibraryDbPinned()) return null;
  return readRecordedCatalogPath(pinnedLibraryPaths().libraryDbPath);
}

/** Record `catalogAbs` in the pinned library (same catalog, new path). */
export function updatePinnedLibraryCatalogPath(catalogAbs: string): void {
  recordCatalogAt(pinnedLibraryPaths().libraryDbPath, catalogAbs);
}
