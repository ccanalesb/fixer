/**
 * The research runs as the first stored cull answers (ticket 15): Laya new on the whole catalog
 * (`laya_new_catalog.jsonl`) and recipe 7H47 on Laya base at 10 and 7 levels
 * (`laya_cull_catalog_all.jsonl`), marked imported from research with their model revision.
 *
 * The rows land in the very stage versions a cull job resolves — the seeded recipe's text is checked
 * against what the research asked — so the next job finds them current and asks Laya nothing.
 * Re-runnable: a row already stored (imported or answered by a job) is never overwritten, so a second
 * run after the 7-level run finishes adds only the new answers.
 *
 * Photos kimi already scored get verdicts like any other: review only, nothing is described or scored.
 */
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import type { Db } from '../db/connection.js';
import { getCurrentPipelineSetting } from '../db/library/cull-pipeline.js';
import { DEFAULT_CULLING_RECIPE_SLUG, seedCullingDefaults } from '../db/library/cull-recipes.js';
import { loadCurrentStageAnswers } from '../db/library/cull-stages.js';
import { listSentByHandKeys } from '../db/library/cull-user-actions.js';
import { finishCullRun, insertCullRun } from '../db/library/cull-verdicts.js';
import { libraryWrite } from '../db/library/write.js';
import { LAYA_QUESTIONS } from '../laya/questions.js';
import { canonicalJson } from '../utils/canonical-json.js';
import { FRAMING_EXCUSAL_QID } from './decide.js';
import { decideAndStorePhoto, type CullContext } from './persist.js';
import { recipeStageKey, resolveCurrentStages, SCORE_FORECAST_STAGE_KEY, type LayaModelIds } from './stages.js';
import type { ResolvedStage, StageAnswers } from './types.js';

/** Photos per transaction. */
const BATCH = 500;

export interface ResearchImportOptions {
  layaNewPath: string;
  recipePath: string;
  modelIds: { base: string; new: string };
  /** Report what would be written, write nothing. */
  dryRun?: boolean;
}

export interface ResearchImportResult {
  dry_run: boolean;
  lines: { laya_new: number; recipe: number };
  /** A half-written last line, skipped: the file is still being appended to. */
  truncated_tail: { laya_new: boolean; recipe: boolean };
  photos: number;
  missing_from_library: number;
  missing_keys_sample: string[];
  /** Level sets or Laya new answers with some questions missing, skipped. */
  partial: number;
  inserted: Record<string, number>;
  already_stored: Record<string, number>;
  verdicts: { cut_by_culling_recipe: number; cut_by_score_forecast: number; pending: number; sent: number };
  run_id: number | null;
}

interface ResearchPhoto {
  image: string;
  recipe: Record<string, number[]>;
  recipeFrom: string[];
  layaNew: StageAnswers | null;
  layaNewFrom: string;
}

interface Jsonl<T> {
  rows: T[];
  lines: number;
  truncatedTail: boolean;
}

/** Every line parsed; only a bad **last** line is tolerated, as a run still appending leaves one. */
async function readJsonl<T>(path: string): Promise<Jsonl<T>> {
  const lines = (await readFile(path, 'utf8')).split('\n');
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop();
  const rows: T[] = [];
  let truncatedTail = false;
  for (const [i, line] of lines.entries()) {
    try {
      rows.push(JSON.parse(line) as T);
    } catch (e) {
      if (i !== lines.length - 1) {
        throw new Error(`${path}: line ${i + 1} is not JSON (${e instanceof Error ? e.message : String(e)})`);
      }
      truncatedTail = true;
    }
  }
  return { rows, lines: lines.length, truncatedTail };
}

interface RecipeLine {
  key: string;
  image: string;
  copied_from: string | null;
  answers: Record<string, { probabilities: number[] }>;
}

interface LayaNewLine {
  key: string;
  image: string;
  from?: string;
  fix?: string;
  why?: string;
  rows: { slug: string; probs: number[]; p_excused?: number | null; not_attempted?: boolean | null }[];
}

/**
 * Laya new's stored rows back into the answers Node gives: one per perspective, and the framing
 * excusal as `[P(no framing device), P(framing device)]`. Rounded to 4 decimals, a P of exactly 0.5
 * takes the side the research's `not_attempted` took.
 */
function layaNewAnswers(line: LayaNewLine): StageAnswers | null {
  const out: StageAnswers = {};
  for (const r of line.rows) out[r.slug] = r.probs;
  const framing = line.rows.find((r) => r.slug === 'framing');
  let pExcused = framing?.p_excused ?? (framing?.not_attempted ? 1 : 0);
  if (pExcused === 0.5 && !framing?.not_attempted) pExcused = 0.49995;
  out[FRAMING_EXCUSAL_QID] = [pExcused, 1 - pExcused];
  const want = Object.keys(LAYA_QUESTIONS.new);
  return want.every((q) => out[q]) ? Object.fromEntries(want.map((q) => [q, out[q]!])) : null;
}

/** The research asked the seeded recipe; refuse to file its answers under text it was not asked. */
function assertResearchText(stage: ResolvedStage): void {
  const research = Object.fromEntries(
    Object.entries(LAYA_QUESTIONS.base).filter(([qid]) => qid.startsWith(`${stage.levelSet}|`)),
  );
  if (canonicalJson(research) !== canonicalJson(stage.questions)) {
    throw new Error(
      `${stage.stageKey}: the recipe's text is no longer the one the research runs answered; ` +
        'the research answers cannot be imported under it',
    );
  }
}

function signatureIfOlder(path: string, fileMtimeMs: number): string | null {
  try {
    const st = statSync(path);
    return st.mtimeMs <= fileMtimeMs ? `${st.size}:${Math.trunc(st.mtimeMs)}` : null;
  } catch {
    return null;
  }
}

export async function importResearchRuns(db: Db, opts: ResearchImportOptions): Promise<ResearchImportResult> {
  const [recipeFile, layaNewFile] = await Promise.all([
    readJsonl<RecipeLine>(opts.recipePath),
    readJsonl<LayaNewLine>(opts.layaNewPath),
  ]);
  const researchMtime = Math.min(statSync(opts.recipePath).mtimeMs, statSync(opts.layaNewPath).mtimeMs);

  const photos = new Map<string, ResearchPhoto>();
  const photo = (key: string, image: string): ResearchPhoto => {
    let p = photos.get(key);
    if (!p) {
      p = { image, recipe: {}, recipeFrom: [], layaNew: null, layaNewFrom: '' };
      photos.set(key, p);
    }
    return p;
  };
  // Lines for one photo are merged: the 7-level run appends its own lines to the 10-level file.
  for (const line of recipeFile.rows) {
    const p = photo(line.key, line.image);
    for (const [qid, a] of Object.entries(line.answers)) p.recipe[qid] = a.probabilities;
    if (line.copied_from) p.recipeFrom.push(line.copied_from);
  }
  let partial = 0;
  for (const line of layaNewFile.rows) {
    const p = photo(line.key, line.image);
    p.layaNew = layaNewAnswers(line);
    if (!p.layaNew) partial += 1;
    p.layaNewFrom = [line.from, line.fix, line.why].filter(Boolean).join(' / ');
  }

  const inLibrary = new Set((db.prepare('SELECT key FROM images').all() as { key: string }[]).map((r) => r.key));
  const missing = [...photos.keys()].filter((k) => !inLibrary.has(k));
  const result: ResearchImportResult = {
    dry_run: opts.dryRun === true,
    lines: { laya_new: layaNewFile.lines, recipe: recipeFile.lines },
    truncated_tail: { laya_new: layaNewFile.truncatedTail, recipe: recipeFile.truncatedTail },
    photos: photos.size - missing.length,
    missing_from_library: missing.length,
    missing_keys_sample: missing.slice(0, 10),
    partial,
    inserted: {},
    already_stored: {},
    verdicts: { cut_by_culling_recipe: 0, cut_by_score_forecast: 0, pending: 0, sent: 0 },
    run_id: null,
  };

  // A dry run does everything inside one transaction and rolls it back.
  if (opts.dryRun) db.exec('BEGIN IMMEDIATE');
  try {
    seedCullingDefaults(db);
    const pipeline = getCurrentPipelineSetting(db);
    const models: LayaModelIds = { base: opts.modelIds.base, new: opts.modelIds.new };
    const stages = resolveCurrentStages(db, pipeline.config, models);
    const recipeStages = ['7', '10'].map((set) => {
      const s = stages.find((st) => st.stageKey === recipeStageKey(DEFAULT_CULLING_RECIPE_SLUG, set));
      if (!s) throw new Error(`the pipeline setting does not run recipe 7H47 at ${set} levels; nothing to import into`);
      assertResearchText(s);
      return s;
    });
    const ctx: CullContext = { stages, pipeline, scoreForecastAvailable: true };
    const runId = libraryWrite(db, () =>
      insertCullRun(db, {
        kind: 'research_import',
        jobId: null,
        pipelineSettingVersion: pipeline.version,
        detail: {
          files: {
            laya_new: { path: opts.layaNewPath, lines: layaNewFile.lines, mtime_ms: statSync(opts.layaNewPath).mtimeMs },
            recipe: { path: opts.recipePath, lines: recipeFile.lines, mtime_ms: statSync(opts.recipePath).mtimeMs },
          },
          model_ids: opts.modelIds,
        },
      }),
    );
    result.run_id = opts.dryRun ? null : runId;
    const sentByHand = listSentByHandKeys(db);
    const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

    const keys = [...photos.keys()].filter((k) => inLibrary.has(k));
    for (let i = 0; i < keys.length; i += BATCH) {
      libraryWrite(db, () => {
        for (const key of keys.slice(i, i + BATCH)) {
          const p = photos.get(key)!;
          const stored = loadCurrentStageAnswers(db, stages, [key]).get(key) ?? {};
          const fresh: Record<string, StageAnswers> = {};
          for (const s of recipeStages) {
            const qids = Object.keys(s.questions);
            const present = qids.filter((q) => p.recipe[q]);
            if (present.length === 0) continue;
            if (present.length < qids.length) {
              partial += 1;
              continue;
            }
            if (stored[s.stageKey]) {
              bump(result.already_stored, s.stageKey);
              continue;
            }
            fresh[s.stageKey] = Object.fromEntries(qids.map((q) => [q.slice(q.indexOf('|') + 1), p.recipe[q]!]));
            bump(result.inserted, s.stageKey);
          }
          if (p.layaNew) {
            if (stored[SCORE_FORECAST_STAGE_KEY]) bump(result.already_stored, SCORE_FORECAST_STAGE_KEY);
            else {
              fresh[SCORE_FORECAST_STAGE_KEY] = p.layaNew;
              bump(result.inserted, SCORE_FORECAST_STAGE_KEY);
            }
          }
          const producedBy = [
            'research (PyTorch)',
            p.recipeFrom.length > 0 ? `recipe copied from ${[...new Set(p.recipeFrom)].join(', ')}` : '',
            p.layaNewFrom ? `Laya new image from ${p.layaNewFrom}` : '',
          ]
            .filter(Boolean)
            .join('; ');
          const d = decideAndStorePhoto(db, ctx, {
            imageKey: key,
            stored,
            fresh: {
              answers: fresh,
              source: 'research_import',
              producedBy,
              imagePath: p.image,
              imageSignature: signatureIfOlder(p.image, researchMtime),
              ifAbsent: true,
            },
            sentByHand: sentByHand.has(key),
            runId,
          });
          if (d.verdict === 'pending') result.verdicts.pending += 1;
          else if (d.verdict === 'sent') result.verdicts.sent += 1;
          else if (d.cutBy === 'culling_recipe') result.verdicts.cut_by_culling_recipe += 1;
          else result.verdicts.cut_by_score_forecast += 1;
        }
      });
    }
    result.partial = partial;
    libraryWrite(db, () => finishCullRun(db, runId, { status: 'complete', ...result }));
  } finally {
    if (opts.dryRun && db.inTransaction) db.exec('ROLLBACK');
  }
  return result;
}
