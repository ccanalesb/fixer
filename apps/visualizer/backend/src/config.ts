/**
 * Runtime configuration.
 *
 * Values are exposed as getters, read on each access, so tests can override env vars
 * without reloading the module.
 *
 * Load `.env` with `node --env-file=.env` rather than a dotenv dependency.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** Resolve a possibly-relative path against the repo root, expanding `~`. */
function resolvePath(p: string): string {
  const expanded = expandUser(p);
  return isAbsolute(expanded) ? expanded : resolve(REPO_ROOT, expanded);
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
    return resolvePath(process.env.DATABASE_PATH ?? 'apps/visualizer/visualizer.db');
  },
  /** `library.db` — images, scores, descriptions, CLIP embeddings. */
  get LIBRARY_DB(): string {
    return resolvePath(process.env.LIBRARY_DB ?? 'library.db');
  },
  get THUMBNAIL_DIR(): string {
    return resolvePath(process.env.THUMBNAIL_DIR ?? 'apps/visualizer/thumbnails');
  },
  /**
   * The repo-level `config.yaml` that `/api/config/*` reads and WRITES.
   *
   * Overridable via `LT_CONFIG_YAML` so tests never rewrite the user's real config.
   */
  get LT_CONFIG_YAML(): string {
    return resolvePath(process.env.LT_CONFIG_YAML ?? 'config.yaml');
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
    return resolvePath(
      process.env.LT_PROVIDERS_JSON ?? 'apps/visualizer/backend/providers.json',
    );
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
  /** Where `scripts/laya/export_onnx.py` writes `laya-base/` and `laya-new/`. */
  layaModelsDir: string;
}

const CONFIG_DEFAULTS = {
  workers: 4,
  // Default when neither env nor config.yaml names a model.
  visionModel: 'gemma3:27b',
  stackBurstDeltaMs: 2000,
  visionCacheDir: join(homedir(), '.cache', 'lightroom_tagger', 'vision'),
  visionCacheEnabled: true,
  ollamaHost: 'http://localhost:11434',
  layaModelsDir: 'models',
} as const;

/**
 * Read `config.yaml` from the repo root. Unknown keys are ignored rather than
 * rejected — the file is user-owned and may still carry keys from retired
 * features (#245).
 */
export function loadLibraryConfig(configPath = join(REPO_ROOT, 'config.yaml')): LibraryConfig {
  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    raw = (parseYaml(readFileSync(configPath, 'utf8')) as Record<string, unknown>) ?? {};
  }
  const pathField = (k: string): string | null => {
    const v = raw[k];
    return typeof v === 'string' && v.length > 0 ? resolvePath(v) : null;
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
        : CONFIG_DEFAULTS.visionCacheDir,
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
    layaModelsDir: pathField('laya_models_dir') ?? resolvePath(CONFIG_DEFAULTS.layaModelsDir),
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
