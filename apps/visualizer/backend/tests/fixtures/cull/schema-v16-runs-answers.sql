-- cull_runs and cull_stage_answers at library schema 16. Frozen: the v17 migration test builds a v16 library from it.
CREATE TABLE cull_runs (
    run_id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('job','research_import','redecide')),
    job_id TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    pipeline_setting_version INTEGER NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE cull_stage_answers (
    image_key TEXT NOT NULL,
    stage_version_id INTEGER NOT NULL REFERENCES cull_stage_versions(id),
    answers_json TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('filtered','passed')),
    decision_json TEXT NOT NULL,
    pipeline_setting_version INTEGER NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('job','research_import')),
    produced_by TEXT NOT NULL DEFAULT '',
    image_path TEXT NOT NULL DEFAULT '',
    image_signature TEXT,
    run_id INTEGER NOT NULL,
    answered_at TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    PRIMARY KEY (image_key, stage_version_id)
);

CREATE INDEX idx_cull_stage_answers_stage
    ON cull_stage_answers(stage_version_id, verdict);
