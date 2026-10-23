/**
 * Create a `library.db`.
 *
 * Fresh databases are created at schema version 8 in one script. Legacy upgrade
 * migrations (below version 8) are not carried here.
 *
 * `image_descriptions_fts` is external-content (`content='image_descriptions'`),
 * matching production; standalone and external-content forms need opposite delete
 * statements (see `removeDescriptionFtsRow`).
 */
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { openLibraryDb, type Db } from '../connection.js';
import { REPO_ROOT } from '../../config.js';
import { nowIsoUtc } from '../../utils/datetime.js';
import { seedCullingDefaults } from './cull-profiles.js';
import { renameCullVocabulary } from './cull-rename-v13.js';
import { addCullingSwitches } from './cull-switches-v14.js';
import { markdownMarksOptional } from './scores.js';
import { prepopulateForecastQuestions, SCORE_FORECAST_QUESTIONS_SQL } from './score-forecast-questions.js';

/** `PRAGMA user_version` for a database created by this module. */
export const LIBRARY_SCHEMA_VERSION = 15;

/** The oldest version `upgradeLibrarySchema` can bring forward. */
const OLDEST_UPGRADABLE_VERSION = 8;

/** Set after the one-time Lightroom keyword backfill in `catalog_sync`. */
export const KEYWORDS_BACKFILL_META_KEY = 'keywords_backfilled_v1';

/**
 * The catalog `catalog_sync` last read, resolved and absolute.
 *
 * What `library.db` actually mirrors, as opposed to what `config.yaml` points at
 * now. The two diverge the moment the catalog path is changed and stay diverged
 * until a sync runs, which is the window the settings UI has to warn about.
 * Absent on a library synced before this key existed.
 */
export const SYNCED_CATALOG_META_KEY = 'synced_catalog_path';

/**
 * Descriptions and scores made from a vision-cache image that has since been
 * turned. `output` is `description` or `score:<perspective slug>`. A row keeps the
 * old output on show while the describe and score jobs treat it as not done; the
 * write that replaces it deletes the row.
 */
const VISION_STALE_SQL = `
CREATE TABLE IF NOT EXISTS vision_stale (
    image_key TEXT NOT NULL,
    output TEXT NOT NULL,
    PRIMARY KEY (image_key, output)
);
`;

/**
 * Culling (version 11, renamed in 13): culling profiles and their text versions, stage versions, one answer row per
 * photo per stage version, the per-photo summary jobs and the UI read, the user's actions, and the
 * versioned pipeline setting. See `cull/` and the culling terms in `CONTEXT.md`.
 *
 * A stage is a culling profile at one level set, or the Score forecast. Its version changes with the
 * model or the text Laya is asked; a rule or threshold change is a new pipeline-setting version instead,
 * re-decided from the stored answers.
 */
const CULL_SQL = `
CREATE TABLE IF NOT EXISTS cull_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    model TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    -- How answers become filtered / passed; not versioned (cull/types.ts ProfileRule).
    rule_json TEXT NOT NULL,
    -- Checked against AI scores; a user's own profile starts unmeasured.
    measured INTEGER NOT NULL DEFAULT 0,
    source_filename TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cull_profile_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES cull_profiles(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    definition_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    is_current INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE (profile_id, version),
    UNIQUE (profile_id, content_hash)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cull_profile_versions_current
    ON cull_profile_versions(profile_id) WHERE is_current = 1;

CREATE TABLE IF NOT EXISTS cull_stage_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stage_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('culling_profile','score_forecast')),
    profile_slug TEXT,
    level_set TEXT,
    model_id TEXT NOT NULL,
    -- Exactly what Laya is asked, by question id.
    questions_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    is_current INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE (stage_key, content_hash)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cull_stage_versions_current
    ON cull_stage_versions(stage_key) WHERE is_current = 1;

CREATE TABLE IF NOT EXISTS cull_runs (
    run_id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('job','research_import','redecide')),
    job_id TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    pipeline_setting_version INTEGER NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS cull_stage_answers (
    image_key TEXT NOT NULL,
    stage_version_id INTEGER NOT NULL REFERENCES cull_stage_versions(id),
    -- Every level probability, lowest level first, by dimension or question id.
    answers_json TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('filtered','passed')),
    -- The rule or threshold that produced the verdict, and the readout.
    decision_json TEXT NOT NULL,
    pipeline_setting_version INTEGER NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('job','research_import')),
    produced_by TEXT NOT NULL DEFAULT '',
    image_path TEXT NOT NULL DEFAULT '',
    -- size:mtime of the image Laya read, when known.
    image_signature TEXT,
    run_id INTEGER NOT NULL,
    answered_at TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    PRIMARY KEY (image_key, stage_version_id)
);

CREATE INDEX IF NOT EXISTS idx_cull_stage_answers_stage
    ON cull_stage_answers(stage_version_id, verdict);

CREATE TABLE IF NOT EXISTS cull_verdicts (
    image_key TEXT PRIMARY KEY,
    verdict TEXT NOT NULL CHECK (verdict IN ('filtered','passed','pending')),
    filtered_by TEXT CHECK (filtered_by IN ('culling_profile','score_forecast')),
    filtered_by_stage_key TEXT,
    sent_by_hand INTEGER NOT NULL DEFAULT 0,
    pending_stages TEXT NOT NULL DEFAULT '[]',
    pending_reason TEXT NOT NULL DEFAULT '',
    score_forecast_off INTEGER NOT NULL DEFAULT 0,
    score_forecast_p8 REAL,
    pipeline_setting_version INTEGER NOT NULL,
    stage_version_ids TEXT NOT NULL DEFAULT '[]',
    run_id INTEGER,
    decided_at TEXT NOT NULL,
    -- What the culling profiles' rules say, whether or not they filter; Lightroom reject follows it.
    culling_profile_verdict TEXT CHECK (culling_profile_verdict IN ('filtered','passed'))
);

CREATE INDEX IF NOT EXISTS idx_cull_verdicts_verdict ON cull_verdicts(verdict, filtered_by);

CREATE TABLE IF NOT EXISTS cull_user_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_key TEXT NOT NULL,
    action TEXT NOT NULL
        CHECK (action IN ('sent_by_hand','agrees_with_filter','should_have_been_filtered')),
    acted_at TEXT NOT NULL,
    -- The summary the action answered; 'none' when the photo had no verdict yet.
    answered_verdict TEXT NOT NULL,
    answered_filtered_by TEXT,
    answered_pipeline_setting_version INTEGER,
    answered_stage_version_ids TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_cull_user_actions_image
    ON cull_user_actions(image_key, acted_at);

CREATE TABLE IF NOT EXISTS cull_pipeline_settings (
    version INTEGER PRIMARY KEY AUTOINCREMENT,
    config_json TEXT NOT NULL,
    is_current INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cull_pipeline_settings_current
    ON cull_pipeline_settings(is_current) WHERE is_current = 1;
`;

/** Lightroom write-back switches and per-photo state (schema 12, #341). */
const LR_WRITEBACK_SQL = `
CREATE TABLE IF NOT EXISTS lr_writeback_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    write_stars INTEGER NOT NULL DEFAULT 0,
    write_reject INTEGER NOT NULL DEFAULT 0,
    stars_profile_slug TEXT
);

INSERT OR IGNORE INTO lr_writeback_settings (id, write_stars, write_reject) VALUES (1, 0, 0);

CREATE TABLE IF NOT EXISTS lr_writeback_state (
    image_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('stars', 'reject')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'written', 'skipped', 'undone')),
    before_pick REAL,
    before_rating REAL,
    written_pick REAL,
    written_rating REAL,
    stars_profile_version_id INTEGER,
    updated_at TEXT NOT NULL,
    written_at TEXT,
    PRIMARY KEY (image_key, kind)
);

CREATE INDEX IF NOT EXISTS idx_lr_writeback_state_status
    ON lr_writeback_state(kind, status);
`;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS images (
    key TEXT PRIMARY KEY,
    id TEXT,
    filename TEXT,
    filepath TEXT,
    date_taken TEXT,
    rating INTEGER DEFAULT 0,
    pick INTEGER DEFAULT 0,
    color_label TEXT DEFAULT '',
    keywords TEXT DEFAULT '[]',
    title TEXT DEFAULT '',
    caption TEXT DEFAULT '',
    description TEXT DEFAULT '',
    copyright TEXT DEFAULT '',
    camera_make TEXT DEFAULT '',
    camera_model TEXT DEFAULT '',
    lens TEXT DEFAULT '',
    focal_length TEXT DEFAULT '',
    aperture TEXT DEFAULT '',
    shutter_speed TEXT DEFAULT '',
    iso TEXT DEFAULT '',
    gps_latitude REAL,
    gps_longitude REAL,
    width INTEGER,
    height INTEGER,
    file_size INTEGER,
    instagram_posted INTEGER DEFAULT 0,
    image_hash TEXT,
    analyzed_at TEXT,
    phash TEXT,
    exif TEXT,
    catalog_path TEXT DEFAULT '',
    -- Lightroom's Adobe_images.orientation. Last because version 10 added it with
    -- ALTER TABLE, and column order is the key order of a SELECT * row.
    orientation TEXT
);

CREATE INDEX IF NOT EXISTS idx_images_filepath ON images(filepath);
CREATE INDEX IF NOT EXISTS idx_images_image_hash ON images(image_hash);
CREATE INDEX IF NOT EXISTS idx_images_date_taken ON images(date_taken);
CREATE INDEX IF NOT EXISTS idx_images_instagram_posted ON images(instagram_posted);

CREATE TABLE IF NOT EXISTS vision_cache (
    key TEXT PRIMARY KEY,
    compressed_path TEXT,
    phash TEXT,
    compressed_at TEXT,
    original_mtime REAL,
    -- The orientation code the cached JPEG was turned to. NULL on rows cached
    -- before version 10, which were never turned.
    orientation TEXT
);

${VISION_STALE_SQL}

CREATE TABLE IF NOT EXISTS image_descriptions (
    image_key TEXT PRIMARY KEY,
    image_type TEXT NOT NULL,
    summary TEXT DEFAULT '',
    composition TEXT DEFAULT '{}',
    perspectives TEXT DEFAULT '{}',
    technical TEXT DEFAULT '{}',
    subjects TEXT DEFAULT '[]',
    best_perspective TEXT DEFAULT '',
    model_used TEXT DEFAULT '',
    described_at TEXT,
    dominant_colors TEXT,
    mood_tags TEXT,
    has_repetition INTEGER,
    description_search_document TEXT
);

CREATE INDEX IF NOT EXISTS idx_desc_image_type ON image_descriptions(image_type);

CREATE TABLE IF NOT EXISTS perspectives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    prompt_markdown TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    source_filename TEXT,
    updated_at TEXT,
    created_at TEXT,
    -- Last, not up beside "active" where it belongs: production got this column
    -- from an ALTER TABLE, and column order is the key order of a SELECT * row.
    -- Moving it would reorder JSON keys the API already emits.
    optional INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS image_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_key TEXT NOT NULL,
    image_type TEXT NOT NULL DEFAULT 'catalog',
    perspective_slug TEXT NOT NULL,
    score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 10),
    rationale TEXT NOT NULL DEFAULT '',
    model_used TEXT NOT NULL DEFAULT '',
    prompt_version TEXT NOT NULL DEFAULT '',
    scored_at TEXT NOT NULL,
    is_current INTEGER NOT NULL DEFAULT 1,
    repaired_from_malformed INTEGER NOT NULL DEFAULT 0,
    not_attempted INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT uq_image_scores_versioned
        UNIQUE (image_key, image_type, perspective_slug, prompt_version)
);

CREATE INDEX IF NOT EXISTS idx_image_scores_perspective_score
    ON image_scores(perspective_slug, score);
CREATE INDEX IF NOT EXISTS idx_image_scores_image
    ON image_scores(image_key, image_type);
CREATE INDEX IF NOT EXISTS idx_image_scores_current
    ON image_scores(image_key, image_type, perspective_slug, is_current);

CREATE TABLE IF NOT EXISTS image_stacks (
    stack_id INTEGER PRIMARY KEY AUTOINCREMENT,
    representative_key TEXT NOT NULL,
    stack_size INTEGER NOT NULL DEFAULT 0,
    user_modified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_image_stacks_representative
    ON image_stacks(representative_key);

CREATE TABLE IF NOT EXISTS image_stack_members (
    stack_id INTEGER NOT NULL
        REFERENCES image_stacks(stack_id) ON DELETE CASCADE,
    image_key TEXT NOT NULL,
    PRIMARY KEY (stack_id, image_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_image_stack_members_image_key
    ON image_stack_members(image_key);

CREATE TABLE IF NOT EXISTS catalog_similarity_groups (
    group_id INTEGER PRIMARY KEY AUTOINCREMENT,
    seed_key TEXT NOT NULL,
    candidate_count INTEGER NOT NULL DEFAULT 0,
    best_similarity REAL NOT NULL DEFAULT 0,
    job_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_catalog_similarity_groups_created
    ON catalog_similarity_groups(created_at DESC, group_id DESC);
CREATE INDEX IF NOT EXISTS idx_catalog_similarity_groups_seed
    ON catalog_similarity_groups(seed_key);

CREATE TABLE IF NOT EXISTS catalog_similarity_candidates (
    group_id INTEGER NOT NULL
        REFERENCES catalog_similarity_groups(group_id) ON DELETE CASCADE,
    candidate_key TEXT NOT NULL,
    similarity REAL NOT NULL,
    rank INTEGER NOT NULL,
    why_matched TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (group_id, candidate_key)
);

CREATE INDEX IF NOT EXISTS idx_catalog_similarity_candidates_group_rank
    ON catalog_similarity_candidates(group_id, rank);

CREATE TABLE IF NOT EXISTS catalog_similarity_rejections (
    key_a TEXT NOT NULL,
    key_b TEXT NOT NULL,
    rejected_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (key_a, key_b),
    CHECK (key_a < key_b)
);

CREATE INDEX IF NOT EXISTS idx_catalog_similarity_rejections_rejected_at
    ON catalog_similarity_rejections(rejected_at DESC);

CREATE TABLE IF NOT EXISTS image_frame_substance (
    image_key TEXT PRIMARY KEY,
    verdict TEXT NOT NULL CHECK (verdict IN ('void','illegible','ok','unknown')),
    unknown_reason TEXT NOT NULL DEFAULT '',
    black_frac_25 REAL,
    blown_frac_235 REAL,
    lap_var REAL,
    tile_max REAL,
    entropy REAL,
    detector_version TEXT NOT NULL,
    judged_at TEXT NOT NULL DEFAULT (datetime('now')),
    run_id INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS frame_substance_overrides (
    image_key TEXT PRIMARY KEY,
    overridden_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_frame_substance_overrides_overridden_at
    ON frame_substance_overrides(overridden_at DESC);

CREATE TABLE IF NOT EXISTS frame_substance_runs (
    run_id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    detector_version TEXT NOT NULL,
    count_void INTEGER NOT NULL DEFAULT 0,
    count_illegible INTEGER NOT NULL DEFAULT 0,
    count_ok INTEGER NOT NULL DEFAULT 0,
    count_unknown INTEGER NOT NULL DEFAULT 0,
    breached INTEGER NOT NULL DEFAULT 0,
    breach_reason TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS library_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

${CULL_SQL}

${LR_WRITEBACK_SQL}

${SCORE_FORECAST_QUESTIONS_SQL}
`;

/**
 * The two virtual tables, which `CREATE VIRTUAL TABLE IF NOT EXISTS` supports but
 * which are kept out of `SCHEMA_SQL` because each depends on something the plain
 * DDL does not: the FTS5 table on `image_descriptions` existing first, and the
 * `vec0` one on the sqlite-vec extension being loaded.
 */
const VIRTUAL_TABLE_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS image_descriptions_fts USING fts5(
    description_search_document,
    tokenize='porter unicode61',
    content='image_descriptions',
    content_rowid='rowid'
);

CREATE VIRTUAL TABLE IF NOT EXISTS image_clip_embeddings USING vec0(
    embedding float[512] distance_metric=cosine,
    image_key TEXT
);
`;

function tableExists(db: Db, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

function userVersion(db: Db): number {
  return Number(db.pragma('user_version', { simple: true }));
}

/**
 * Refuse a database that predates the current schema.
 *
 * A missing or empty path is treated as new. An existing `images` table with
 * `user_version` below the current needs legacy upgrade migrations this module
 * does not carry.
 */
function assertNotLegacy(db: Db, path: string): void {
  const version = userVersion(db);
  if (version >= OLDEST_UPGRADABLE_VERSION) return;
  if (!tableExists(db, 'images')) return;
  throw new Error(
    `${path} is at schema version ${version}, below ${OLDEST_UPGRADABLE_VERSION}. ` +
      'The TypeScript CLI does not carry the upgrade migrations; run the Python ' +
      '`lightroom-tagger init` against it once first.',
  );
}

/** Read one `library_meta` row, or `null` when the table or key is absent. */
export function getLibraryMeta(db: Db, key: string): string | null {
  if (!tableExists(db, 'library_meta')) return null;
  const row = db.prepare('SELECT value FROM library_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/** Upsert one `library_meta` row. Does NOT commit — call inside `libraryWrite`. */
export function setLibraryMeta(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO library_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/** `ALTER TABLE … ADD COLUMN`, skipped when the table is absent or already has it. */
function addColumnIfMissing(db: Db, table: string, columnDef: string): void {
  if (!tableExists(db, table)) return;
  const name = columnDef.split(' ')[0]!;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((c) => c.name === name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
}

/**
 * Upgrade an existing `library.db` to the current schema version. Idempotent, and
 * a no-op on a database with no tables yet.
 */
export function upgradeLibrarySchema(db: Db): void {
  const version = userVersion(db);
  if (version >= LIBRARY_SCHEMA_VERSION) return;
  assertNotLegacy(db, 'library.db');
  if (version < OLDEST_UPGRADABLE_VERSION) return;
  db.transaction(() => {
    if (version < 9) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS library_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
      `);
    }
    if (version < 10) {
      addColumnIfMissing(db, 'images', 'orientation TEXT');
      addColumnIfMissing(db, 'vision_cache', 'orientation TEXT');
      db.exec(VISION_STALE_SQL);
    }
    if (version < 11) {
      db.exec(CULL_SQL);
      seedCullingDefaults(db);
    }
    if (version < 12) {
      db.exec(LR_WRITEBACK_SQL);
    }
    if (version < 13) {
      renameCullVocabulary(db, CULL_SQL);
    }
    if (version < 14) {
      addCullingSwitches(db);
    }
    if (version < 15) {
      db.exec(SCORE_FORECAST_QUESTIONS_SQL);
      prepopulateForecastQuestions(db);
    }
    db.pragma(`user_version = ${LIBRARY_SCHEMA_VERSION}`);
  })();
}

/** Create every table and index at the current version. Idempotent; seeds nothing. */
export function createLibrarySchema(db: Db): void {
  db.exec(SCHEMA_SQL);
  db.exec(VIRTUAL_TABLE_SQL);
  db.pragma(`user_version = ${LIBRARY_SCHEMA_VERSION}`);
}

/**
 * Create (or adopt) `library.db` at `path` with the current schema and the
 * factory perspectives. Idempotent; the caller owns closing the connection.
 */
export function initLibraryDb(path: string): Db {
  // Ensure the parent directory exists so `init --db` into a new path works.
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = openLibraryDb(path);
  try {
    assertNotLegacy(db, path);
    // Before the CREATEs: they would stamp the current version on old tables.
    upgradeLibrarySchema(db);
    createLibrarySchema(db);
    seedPerspectivesFromPromptsDir(db);
    seedCullingDefaults(db);
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

/** Where the factory perspective rubrics live, as markdown. */
export const PERSPECTIVE_PROMPTS_DIR = join(REPO_ROOT, 'prompts', 'perspectives');

/**
 * Title-case each run of letters (not word-boundary regex), so
 * `environmental-context-legibility` becomes `Environmental-Context-Legibility`.
 */
function pythonTitle(s: string): string {
  return s.replace(/\p{L}+/gu, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase());
}

/**
 * Seed value for `perspectives.description`: first non-blank body line, skipping
 * a leading `# Heading`.
 *
 * On rubrics with `<!-- optional: true -->` immediately under the heading, that
 * marker becomes the description — what the factory seed has always produced.
 */
export function perspectiveSeedDescription(markdown: string): string {
  const lines = markdown.split(/\r\n|\r|\n/);
  let i = 0;
  while (i < lines.length && !lines[i]!.trim()) i += 1;
  if (i >= lines.length) return '';

  const first = lines[i]!.trim();
  if (!first.startsWith('# ')) return first;

  i += 1;
  while (i < lines.length && !lines[i]!.trim()) i += 1;
  if (i >= lines.length) return first.replace(/^#+/, '').trim();
  return lines[i]!.trim();
}

/**
 * Insert the factory perspective rows from `prompts/perspectives/*.md` when
 * `perspectives` is empty. Returns how many were inserted.
 *
 * The emptiness check is the whole contract: the seed is a one-time factory
 * default and the database is authoritative afterwards, so an owner who deletes a
 * rubric does not get it back on the next `init`.
 */
export function seedPerspectivesFromPromptsDir(
  db: Db,
  promptsDir: string = PERSPECTIVE_PROMPTS_DIR,
): number {
  const existing = db.prepare('SELECT COUNT(*) AS cnt FROM perspectives').get() as {
    cnt: number;
  };
  if (Number(existing.cnt) > 0) return 0;

  let entries: string[];
  try {
    if (!statSync(promptsDir).isDirectory()) return 0;
    entries = readdirSync(promptsDir).sort();
  } catch {
    return 0;
  }

  const now = nowIsoUtc();
  const insert = db.prepare(
    `INSERT INTO perspectives (
       slug, display_name, description, prompt_markdown,
       active, optional, source_filename, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  for (const name of entries) {
    if (extname(name).toLowerCase() !== '.md') continue;
    const full = join(promptsDir, name);
    if (!statSync(full).isFile()) continue;

    const slug = name.slice(0, -extname(name).length);
    const text = readFileSync(full, 'utf8');
    insert.run(
      slug,
      pythonTitle(slug.replaceAll('_', ' ')),
      perspectiveSeedDescription(text),
      text,
      markdownMarksOptional(text) ? 1 : 0,
      name,
      now,
      now,
    );
    inserted += 1;
  }
  return inserted;
}
