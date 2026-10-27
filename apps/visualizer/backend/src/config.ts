/**
 * Runtime configuration.
 *
 * Values are exposed as getters, read on each access, so tests can override env vars
 * without reloading the module.
 *
 * Load `.env` with `node --env-file=.env` rather than a dotenv dependency.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Monorepo root — `apps/visualizer/backend/src` → four levels up. */
export const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function expandUser(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

/** User-writable state: defaults to the repo root in a source install. */
export function dataRoot(): string {
  const raw = process.env.LT_DATA_DIR;
  return raw ? resolve(expandUser(raw)) : REPO_ROOT;
}

/** Read-only bundle content: defaults to the repo root in a source install. */
export function resourcesRoot(): string {
  const raw = process.env.LT_RESOURCES_DIR;
  return raw ? resolve(expandUser(raw)) : REPO_ROOT;
}

/** Base for resolving relative paths in env overrides and config.yaml path fields. */
export function pathBase(): string {
  return process.env.LT_DATA_DIR ? dataRoot() : REPO_ROOT;
}

/** Resolve a possibly-relative path, expanding `~`. */
export function resolvePath(p: string, base = REPO_ROOT): string {
  const expanded = expandUser(p);
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

/**
 * Default location for a user-owned file: repo-relative when roots are unset,
 * a flat name under the data folder when `LT_DATA_DIR` is set.
 */
export function resolveDataPath(repoRelativeWhenUnset: string, dataFolderRelative: string): string {
  if (process.env.LT_DATA_DIR) {
    return resolve(dataRoot(), dataFolderRelative);
  }
  return resolvePath(repoRelativeWhenUnset);
}

/** Shipped provider template the registry copies on first use. */
export function providersExamplePath(): string {
  return process.env.LT_RESOURCES_DIR
    ? join(resourcesRoot(), 'providers.example.json')
    : join(REPO_ROOT, 'apps', 'visualizer', 'backend', 'providers.example.json');
}

function defaultConfigYamlPath(): string {
  const env = process.env.LT_CONFIG_YAML;
  if (env) return resolvePath(env, pathBase());
  return resolveDataPath('config.yaml', 'config.yaml');
}

function defaultVisionCacheDir(): string {
  if (process.env.LT_DATA_DIR) {
    return join(dataRoot(), 'vision-cache');
  }
  return join(homedir(), '.cache', 'lightroom_tagger', 'vision');
}

export const HOST_DEFAULT = 'localhost';
/**
 * 5001, not 5000: on macOS the AirPlay Receiver occupies :5000 and answers
 * requests, which presents as a broken backend. The Vite dev proxy targets 5001.
 */
export const PORT_DEFAULT = 5001;

export const config = {
  get HOST(): string {
    return process.env.FLASK_HOST ?? HOST_DEFAULT;
  },
  get PORT(): number {
    const raw = process.env.FLASK_PORT;
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) ? n : PORT_DEFAULT;
  },
  get DEBUG(): boolean {
    return (process.env.FLASK_DEBUG ?? 'true').toLowerCase() === 'true';
  },
  get FRONTEND_ORIGINS(): string[] {
    return (
      process.env.FRONTEND_URL ?? 'http://localhost:5173,http://localhost:5174'
    ).split(',');
  },
  /** `visualizer.db` — jobs, logs, checkpoints. Separate from the library DB. */
  get VISUALIZER_DB(): string {
    const env = process.env.DATABASE_PATH;
    if (env) return resolvePath(env, pathBase());
    return resolveDataPath('apps/visualizer/visualizer.db', 'visualizer.db');
  },
  /** `library.db` — images, scores, descriptions, CLIP embeddings. */
  get LIBRARY_DB(): string {
    return resolveLibraryDbLocation().path;
  },
  get THUMBNAIL_DIR(): string {
    const env = process.env.THUMBNAIL_DIR;
    if (env) return resolvePath(env, pathBase());
    return resolveDataPath('apps/visualizer/thumbnails', 'thumbnails');
  },
  /**
   * The repo-level `config.yaml` that `/api/config/*` reads and WRITES.
   *
   * Overridable via `LT_CONFIG_YAML` so tests never rewrite the user's real config.
   */
  get LT_CONFIG_YAML(): string {
    return defaultConfigYamlPath();
  },
  /**
   * `providers.json` — provider endpoints, models and defaults, which
   * `/api/providers/*` reads and WRITES.
   *
   * Gitignored and user-owned; the registry bootstraps it from
   * `providers.example.json` on first use. Overridable for the same reason
   * `LT_CONFIG_YAML` is: a test of the PUT handlers would otherwise rewrite the
   * user's real provider list, including their configured models.
   */
  get LT_PROVIDERS_JSON(): string {
    const env = process.env.LT_PROVIDERS_JSON;
    if (env) return resolvePath(env, pathBase());
    return resolveDataPath('apps/visualizer/backend/providers.json', 'providers.json');
  },
} as const;

export interface LibraryConfig {
  catalogPath: string | null;
  /** The raw, unexpanded value as written in config.yaml. `/api/config/catalog`
   *  returns both this and the expanded form, so it cannot be normalized away. */
  catalogPathRaw: string;
  /** Optional reduced-size `.lrcat` used for fast test runs; `''` when unset. */
  smallCatalogPath: string;
  dbPath: string | null;
  mountPoint: string | null;
  workers: number;
  /** Falls back to the dataclass default, not null — see `getVisionModel`. */
  visionModel: string;
  visionCacheDir: string;
  visionCacheEnabled: boolean;
  ollamaHost: string;
  stackBurstDeltaMs: number;
  /** The models installed in this app, one directory each, written by `scripts/app-models/export_onnx.py`. */
  appModelsDir: string;
  /** The System One endpoint and model each culling stage calls (`culling_models`). */
  cullingModels: CullingModelsConfig;
}

/** One stage's System One endpoint: `this_app` or a URL, the model (`''` for none), and an API key (`''` for none). */
export interface CullingModelConfig {
  endpoint: string;
  model: string;
  apiKey: string;
}

export interface CullingModelsConfig {
  culling_profile: CullingModelConfig;
  score_forecast: CullingModelConfig;
}

/** A new install: this app's endpoint, and no model until the user chooses one. */
export const CULLING_MODELS_DEFAULTS: CullingModelsConfig = {
  culling_profile: { endpoint: 'this_app', model: '', apiKey: '' },
  score_forecast: { endpoint: 'this_app', model: '', apiKey: '' },
};

function cullingModelsField(raw: unknown): CullingModelsConfig {
  const block = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const stage = (key: keyof CullingModelsConfig): CullingModelConfig => {
    const v = block[key] && typeof block[key] === 'object' ? (block[key] as Record<string, unknown>) : {};
    const str = (k: string, fallback: string) => (typeof v[k] === 'string' && v[k] ? (v[k] as string) : fallback);
    const d = CULLING_MODELS_DEFAULTS[key];
    return { endpoint: str('endpoint', d.endpoint), model: str('model', d.model), apiKey: str('api_key', d.apiKey) };
  };
  return { culling_profile: stage('culling_profile'), score_forecast: stage('score_forecast') };
}

/** Write one stage's `culling_models` entry into `config.yaml`, keeping the other stage and every other key. */
export function updateConfigYamlCullingModel(
  configFile: string,
  stage: keyof CullingModelsConfig,
  value: CullingModelConfig,
): void {
  const current = loadLibraryConfig(configFile).cullingModels;
  const next = { ...current, [stage]: value };
  const entry = (m: CullingModelConfig) => ({ endpoint: m.endpoint, model: m.model, api_key: m.apiKey });
  updateConfigYaml(configFile, 'culling_models', {
    culling_profile: entry(next.culling_profile),
    score_forecast: entry(next.score_forecast),
  });
}

const CONFIG_DEFAULTS = {
  workers: 4,
  // Default when neither env nor config.yaml names a model.
  visionModel: 'gemma3:27b',
  stackBurstDeltaMs: 2000,
  visionCacheEnabled: true,
  ollamaHost: 'http://localhost:11434',
  appModelsDir: 'models',
} as const;

/**
 * Read `config.yaml`. Unknown keys are ignored rather than rejected — the file is
 * user-owned and may still carry keys from retired features.
 */
export function loadLibraryConfig(configPath = defaultConfigYamlPath()): LibraryConfig {
  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    raw = (parseYaml(readFileSync(configPath, 'utf8')) as Record<string, unknown>) ?? {};
  }
  const pathField = (k: string): string | null => {
    const v = raw[k];
    return typeof v === 'string' && v.length > 0 ? resolvePath(v, pathBase()) : null;
  };
  return {
    catalogPath: pathField('catalog_path'),
    catalogPathRaw: typeof raw.catalog_path === 'string' ? raw.catalog_path : '',
    smallCatalogPath:
      typeof raw.small_catalog_path === 'string' ? raw.small_catalog_path : '',
    dbPath: pathField('db_path'),
    // A mount point is an absolute filesystem location; never repo-relative.
    mountPoint: typeof raw.mount_point === 'string' ? expandUser(raw.mount_point) : null,
    workers: typeof raw.workers === 'number' ? raw.workers : CONFIG_DEFAULTS.workers,
    visionModel:
      typeof raw.vision_model === 'string' && raw.vision_model
        ? raw.vision_model
        : CONFIG_DEFAULTS.visionModel,
    visionCacheDir:
      typeof raw.vision_cache_dir === 'string'
        ? expandUser(raw.vision_cache_dir)
        : defaultVisionCacheDir(),
    visionCacheEnabled:
      typeof raw.vision_cache_enabled === 'boolean'
        ? raw.vision_cache_enabled
        : CONFIG_DEFAULTS.visionCacheEnabled,
    ollamaHost:
      typeof raw.ollama_host === 'string' ? raw.ollama_host : CONFIG_DEFAULTS.ollamaHost,
    stackBurstDeltaMs:
      typeof raw.stack_burst_delta_ms === 'number'
        ? Math.trunc(raw.stack_burst_delta_ms)
        : CONFIG_DEFAULTS.stackBurstDeltaMs,
    appModelsDir:
      pathField('app_models_dir') ??
      resolveDataPath(CONFIG_DEFAULTS.appModelsDir, CONFIG_DEFAULTS.appModelsDir),
    cullingModels: cullingModelsField(raw.culling_models),
  };
}

/**
 * Read `config.yaml` as a plain map, merge one key, and write it back.
 *
 * Preserves every other key and their order. This file is user-owned, so a rewrite
 * must not reorder or drop anything it does not understand.
 */
function updateConfigYaml(configFile: string, key: string, value: unknown): void {
  let data: Record<string, unknown> = {};
  if (existsSync(configFile)) {
    data = (parseYaml(readFileSync(configFile, 'utf8')) as Record<string, unknown>) ?? {};
  } else {
    mkdirSync(dirname(configFile), { recursive: true });
  }
  data[key] = value;
  writeFileSync(configFile, stringifyYaml(data, { lineWidth: 0 }), 'utf8');
}

/** Write `catalog_path` into `config.yaml`, preserving other keys. */
export function updateConfigYamlCatalogPath(configFile: string, catalogPath: string): void {
  const stripped = catalogPath.trim();
  if (!stripped) throw new Error('catalog_path must be non-empty');
  updateConfigYaml(configFile, 'catalog_path', stripped);
}

/** Write `stack_burst_delta_ms` into `config.yaml`, preserving other keys. */
export function updateConfigYamlStackBurstDeltaMs(configFile: string, value: number): void {
  const intValue = Math.trunc(value);
  if (intValue < 1) throw new Error('stack_burst_delta_ms must be at least 1');
  updateConfigYaml(configFile, 'stack_burst_delta_ms', intValue);
}

/** `Path(value).expanduser()` — the only expansion the config routes apply. */
export function expandUserPath(p: string): string {
  return expandUser(p);
}

/**
 * The vision model to use, by the documented precedence.
 *
 * `VISION_MODEL` overrides config.yaml; `DESCRIPTION_VISION_MODEL` overrides
 * both for the describe path specifically, which is how the
 * `/api/descriptions/{key}/generate` route honours a per-request `model`.
 */
export function getVisionModel(): string {
  return process.env.VISION_MODEL ?? loadLibraryConfig(config.LT_CONFIG_YAML).visionModel;
}

export function getDescriptionModel(): string {
  return process.env.DESCRIPTION_VISION_MODEL ?? getVisionModel();
}

export type LibraryDbSource = 'env' | 'config' | 'default';

export interface LibraryDbStatus {
  path: string;
  source: LibraryDbSource;
  exists: boolean;
  /** Human-readable explanation when unavailable. */
  reason: string | null;
}

function libraryDbIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolved path and how it was chosen; does not require the file to exist. */
export function resolveLibraryDbLocation(): { path: string; source: LibraryDbSource } {
  const envValue = process.env.LIBRARY_DB;
  if (envValue) {
    return { path: resolvePath(envValue, pathBase()), source: 'env' };
  }

  const configPath = defaultConfigYamlPath();
  const cfg = loadLibraryConfig(configPath);
  if (cfg.dbPath) {
    return { path: cfg.dbPath, source: 'config' };
  }

  return {
    path: resolveDataPath('library.db', 'library.db'),
    source: 'default',
  };
}

/** Resolve the library DB path and report whether it exists. */
export function describeLibraryDb(): LibraryDbStatus {
  const location = resolveLibraryDbLocation();
  const exists = libraryDbIsFile(location.path);
  return {
    path: location.path,
    source: location.source,
    exists,
    reason: exists
      ? null
      : location.source === 'env'
        ? `LIBRARY_DB is set to '${location.path}' but that file does not exist.`
        : location.source === 'config'
          ? `config.yaml db_path is '${location.path}' but that file does not exist. ` +
            'Run the catalog import to create it, or set LIBRARY_DB to override.'
          : 'No LIBRARY_DB env var, no db_path in config.yaml, and no library.db under the ' +
            'data folder. Set LIBRARY_DB or configure db_path in config.yaml.',
  };
}

/** The resolved path when it exists, otherwise `null`. */
export function resolveLibraryDb(): string | null {
  const status = describeLibraryDb();
  return status.exists ? status.path : null;
}

/** The resolved path, or throw with the reason a health endpoint would show. */
export function requireLibraryDb(): string {
  const status = describeLibraryDb();
  if (status.exists) return status.path;
  throw new Error(status.reason ?? 'Library database is not configured.');
}
