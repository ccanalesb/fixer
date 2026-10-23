/**
 * Stage versions and the answers stored under them: one row per photo per stage version, with every
 * level probability. Old versions and their rows stay as history; only current versions are read.
 */
import { createHash } from 'node:crypto';
import type { StageModelIds } from '../../cull/stage-models.js';
import type { CullVerdict, ResolvedStage, StageAnswers, StageKind } from '../../cull/types.js';
import type { LayaQuestion } from '../../laya/rows.js';
import { canonicalJson } from '../../utils/canonical-json.js';
import { nowIsoUtc } from '../../utils/datetime.js';
import type { Db } from '../connection.js';
import { libraryWrite } from './write.js';

export interface StageVersionSpec {
  stageKey: string;
  kind: StageKind;
  profileSlug: string | null;
  levelSet: string | null;
  modelId: string;
  questions: Record<string, LayaQuestion>;
}

/** The model and exactly what it is asked: a change to either is a new version. */
export function stageContentHash(spec: Pick<StageVersionSpec, 'modelId' | 'questions'>): string {
  return createHash('sha256')
    .update(canonicalJson({ model_id: spec.modelId, questions: spec.questions }))
    .digest('hex');
}

/** The version for this text and model, made current; created when new. Returns its id. */
export function getOrCreateStageVersion(db: Db, spec: StageVersionSpec): number {
  const hash = stageContentHash(spec);
  return libraryWrite(db, () => {
    const existing = db
      .prepare('SELECT id, is_current FROM cull_stage_versions WHERE stage_key = ? AND content_hash = ?')
      .get(spec.stageKey, hash) as { id: number; is_current: number } | undefined;
    if (existing?.is_current === 1) return existing.id;
    db.prepare('UPDATE cull_stage_versions SET is_current = 0 WHERE stage_key = ?').run(spec.stageKey);
    if (existing) {
      db.prepare('UPDATE cull_stage_versions SET is_current = 1 WHERE id = ?').run(existing.id);
      return existing.id;
    }
    const info = db
      .prepare(
        `INSERT INTO cull_stage_versions
           (stage_key, kind, profile_slug, level_set, model_id, questions_json, content_hash, is_current, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        spec.stageKey,
        spec.kind,
        spec.profileSlug,
        spec.levelSet,
        spec.modelId,
        JSON.stringify(spec.questions),
        hash,
        nowIsoUtc(),
      );
    return Number(info.lastInsertRowid);
  });
}

export interface StageAnswerRow {
  imageKey: string;
  stageVersionId: number;
  answers: StageAnswers;
  verdict: CullVerdict;
  decision: Record<string, unknown>;
  pipelineSettingVersion: number;
  source: 'job' | 'research_import';
  producedBy?: string;
  imagePath?: string;
  imageSignature?: string | null;
  runId: number;
  answeredAt?: string;
}

/**
 * Store one stage's answers for a photo. `ifAbsent` keeps a row that is already there (the research
 * import never overwrites a job's answers); returns whether a row was written.
 */
export function upsertStageAnswer(db: Db, row: StageAnswerRow, opts: { ifAbsent?: boolean } = {}): boolean {
  const now = nowIsoUtc();
  const conflict = opts.ifAbsent
    ? 'DO NOTHING'
    : `DO UPDATE SET answers_json = excluded.answers_json, verdict = excluded.verdict,
         decision_json = excluded.decision_json, pipeline_setting_version = excluded.pipeline_setting_version,
         source = excluded.source, produced_by = excluded.produced_by, image_path = excluded.image_path,
         image_signature = excluded.image_signature, run_id = excluded.run_id,
         answered_at = excluded.answered_at, decided_at = excluded.decided_at`;
  const info = db
    .prepare(
      `INSERT INTO cull_stage_answers
         (image_key, stage_version_id, answers_json, verdict, decision_json, pipeline_setting_version,
          source, produced_by, image_path, image_signature, run_id, answered_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (image_key, stage_version_id) ${conflict}`,
    )
    .run(
      row.imageKey,
      row.stageVersionId,
      JSON.stringify(row.answers),
      row.verdict,
      JSON.stringify(row.decision),
      row.pipelineSettingVersion,
      row.source,
      row.producedBy ?? '',
      row.imagePath ?? '',
      row.imageSignature ?? null,
      row.runId,
      row.answeredAt ?? now,
      now,
    );
  return info.changes > 0;
}

/** Re-decided stage verdict, from stored answers, without touching the answers. */
export function updateStageDecision(
  db: Db,
  imageKey: string,
  stageVersionId: number,
  verdict: CullVerdict,
  decision: Record<string, unknown>,
  pipelineSettingVersion: number,
): void {
  db.prepare(
    `UPDATE cull_stage_answers SET verdict = ?, decision_json = ?, pipeline_setting_version = ?, decided_at = ?
     WHERE image_key = ? AND stage_version_id = ?`,
  ).run(verdict, JSON.stringify(decision), pipelineSettingVersion, nowIsoUtc(), imageKey, stageVersionId);
}

/** Photos per query: well under SQLite's bound-parameter limit. */
const KEYS_PER_QUERY = 500;

/** Answers under the current versions of `stages`, by photo and then stage key; one query per 500 photos. */
export function loadCurrentStageAnswers(
  db: Db,
  stages: readonly ResolvedStage[],
  imageKeys: readonly string[],
): Map<string, Record<string, StageAnswers>> {
  const out = new Map<string, Record<string, StageAnswers>>();
  if (stages.length === 0 || imageKeys.length === 0) return out;
  const keyByVersion = new Map(stages.map((s) => [s.versionId, s.stageKey]));
  const ids = stages.map((s) => s.versionId);
  for (let i = 0; i < imageKeys.length; i += KEYS_PER_QUERY) {
    const chunk = imageKeys.slice(i, i + KEYS_PER_QUERY);
    const rows = db
      .prepare(
        `SELECT image_key, stage_version_id, answers_json FROM cull_stage_answers
         WHERE image_key IN (${chunk.map(() => '?').join(',')})
           AND stage_version_id IN (${ids.map(() => '?').join(',')})`,
      )
      .all(...chunk, ...ids) as { image_key: string; stage_version_id: number; answers_json: string }[];
    for (const r of rows) {
      const byStage = out.get(r.image_key) ?? {};
      byStage[keyByVersion.get(r.stage_version_id)!] = JSON.parse(r.answers_json) as StageAnswers;
      out.set(r.image_key, byStage);
    }
  }
  return out;
}

/** Which current stages each photo has an answer for, without parsing the answers. */
export function loadAnsweredStageKeys(db: Db, stages: readonly ResolvedStage[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (stages.length === 0) return out;
  const keyByVersion = new Map(stages.map((s) => [s.versionId, s.stageKey]));
  const rows = db
    .prepare(
      `SELECT image_key, stage_version_id FROM cull_stage_answers
       WHERE stage_version_id IN (${stages.map(() => '?').join(',')})`,
    )
    .all(...stages.map((s) => s.versionId)) as { image_key: string; stage_version_id: number }[];
  for (const r of rows) {
    const set = out.get(r.image_key) ?? new Set<string>();
    set.add(keyByVersion.get(r.stage_version_id)!);
    out.set(r.image_key, set);
  }
  return out;
}

/** Photos with an answer under any current version of this stage kind, each counted once. */
export function countPhotosAnsweredByCurrentStage(db: Db, kind: StageKind): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT a.image_key) AS n FROM cull_stage_answers a
       JOIN cull_stage_versions v ON v.id = a.stage_version_id
       WHERE v.kind = ? AND v.is_current = 1`,
    )
    .get(kind) as { n: number };
  return row.n;
}

/**
 * The model identity each stage kind's current versions were made with; null for a kind never
 * answered. What re-decide resolves stages with, so it never calls an endpoint.
 */
export function readStoredStageModelIds(db: Db): StageModelIds {
  const modelOf = (kind: StageKind) =>
    (
      db
        .prepare('SELECT model_id FROM cull_stage_versions WHERE kind = ? AND is_current = 1 ORDER BY id DESC LIMIT 1')
        .get(kind) as { model_id: string } | undefined
    )?.model_id ?? null;
  return { culling_profile: modelOf('culling_profile'), score_forecast: modelOf('score_forecast') };
}
