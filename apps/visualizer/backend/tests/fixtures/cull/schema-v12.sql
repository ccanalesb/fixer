-- The cull and Lightroom write-back tables at library schema 12, before the v13 rename. Frozen: the v13 migration test builds a v12 library from it.
CREATE TABLE IF NOT EXISTS cull_recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    model TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    -- How answers become cut / sent; not versioned (cull/types.ts RecipeRule).
    rule_json TEXT NOT NULL,
    -- Checked against AI scores; a user's own recipe starts unmeasured.
    measured INTEGER NOT NULL DEFAULT 0,
    source_filename TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cull_recipe_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipe_id INTEGER NOT NULL REFERENCES cull_recipes(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    definition_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    is_current INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE (recipe_id, version),
    UNIQUE (recipe_id, content_hash)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cull_recipe_versions_current
    ON cull_recipe_versions(recipe_id) WHERE is_current = 1;

CREATE TABLE IF NOT EXISTS cull_stage_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stage_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('culling_recipe','score_forecast')),
    recipe_slug TEXT,
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
    verdict TEXT NOT NULL CHECK (verdict IN ('cut','sent')),
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
    verdict TEXT NOT NULL CHECK (verdict IN ('cut','sent','pending')),
    cut_by TEXT CHECK (cut_by IN ('culling_recipe','score_forecast')),
    cut_by_stage_key TEXT,
    sent_by_hand INTEGER NOT NULL DEFAULT 0,
    pending_stages TEXT NOT NULL DEFAULT '[]',
    pending_reason TEXT NOT NULL DEFAULT '',
    score_forecast_off INTEGER NOT NULL DEFAULT 0,
    score_forecast_p8 REAL,
    pipeline_setting_version INTEGER NOT NULL,
    stage_version_ids TEXT NOT NULL DEFAULT '[]',
    run_id INTEGER,
    decided_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cull_verdicts_verdict ON cull_verdicts(verdict, cut_by);

CREATE TABLE IF NOT EXISTS cull_user_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_key TEXT NOT NULL,
    action TEXT NOT NULL
        CHECK (action IN ('sent_by_hand','agrees_with_cut','should_have_been_cut')),
    acted_at TEXT NOT NULL,
    -- The summary the action answered; 'none' when the photo had no verdict yet.
    answered_verdict TEXT NOT NULL,
    answered_cut_by TEXT,
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

CREATE TABLE IF NOT EXISTS lr_writeback_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    write_stars INTEGER NOT NULL DEFAULT 0,
    write_reject INTEGER NOT NULL DEFAULT 0,
    stars_recipe_slug TEXT
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
    stars_recipe_version_id INTEGER,
    updated_at TEXT NOT NULL,
    written_at TEXT,
    PRIMARY KEY (image_key, kind)
);

CREATE INDEX IF NOT EXISTS idx_lr_writeback_state_status
    ON lr_writeback_state(kind, status);
