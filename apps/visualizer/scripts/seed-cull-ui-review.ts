/**
 * Seeds a temp library.db for dev-cull-ui.sh — rich cull review + catalog fixtures.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { catalogBaseNameFromImageKey } from '../backend/src/lightroom/writer.js';
import { makeFakeCatalog } from '../backend/tests/helpers/fake-catalog.js';
import { patchLrWritebackSettings } from '../backend/src/db/library/lr-writeback-settings.js';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { resolveCurrentStages } from '../backend/src/cull/stages.js';
import { initLibraryDb } from '../backend/src/db/library/bootstrap.js';
import { getCurrentPipelineSetting } from '../backend/src/db/library/cull-pipeline.js';
import { upsertStageAnswer } from '../backend/src/db/library/cull-stages.js';
import {
  finishCullRun,
  insertCullRun,
  upsertCullVerdict,
  type CullVerdictInput,
} from '../backend/src/db/library/cull-verdicts.js';
import { recordCullUserAction } from '../backend/src/db/library/cull-user-actions.js';
import type { ResolvedStage } from '../backend/src/cull/types.js';
import { computePromptVersion } from '../backend/src/vision/scoring-service.js';
import { writeFakeLayaModels } from '../backend/tests/helpers/fake-laya.js';

const libPath = process.env.LIBRARY_DB;
const tmpRoot = process.env.CULL_UI_TMP;
if (!libPath || !tmpRoot) {
  console.error('LIBRARY_DB and CULL_UI_TMP required');
  process.exit(1);
}

const PROTOTYPE_IMG = join(
  homedir(),
  'projects/lightroom-tagger-research-laya/docs/research/wayfinder/pre-selector/prototypes/17-cut-photos-ui/img',
);

const vision = join(tmpRoot, 'vision');
const models = join(tmpRoot, 'models');
mkdirSync(vision, { recursive: true });
writeFakeLayaModels(models, { withNew: true });

const DIMS = ['immediate-impact', 'visual-structure', 'point-of-tension', 'connotation'] as const;

function levelPick(levelSet: '7' | '10', dim: string, levelIndex: number): Record<string, number[]> {
  const n = levelSet === '7' ? 7 : 10;
  const v = Array<number>(n).fill(0);
  v[Math.min(levelIndex, n - 1)] = 1;
  return { [`${levelSet}|${dim}`]: v };
}

function recipeAnswers(levelSet: '7' | '10', levelIndex: number): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const dim of DIMS) {
    Object.assign(out, levelPick(levelSet, dim, levelIndex));
  }
  return out;
}

function forecastAnswers(stage: ResolvedStage, high: boolean): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [qid, q] of Object.entries(stage.questions)) {
    const criteria = q.criteria;
    const n = Array.isArray(criteria) ? criteria.length : 2;
    const v = Array<number>(n).fill(0);
    if (high) {
      v[n - 1] = 0.55;
      v[n - 2] = 0.45;
    } else {
      v[0] = 0.55;
      v[1] = 0.45;
    }
    out[qid] = v;
  }
  return out;
}

/** Product-shaped library key and matching `AgLibraryFile.baseName` for the temp `.lrcat`. */
function prototypeKeyAndBaseName(file: string): { key: string; catalogBaseName: string } {
  const stem = basename(file, '.jpg');
  const m = stem.match(/^(\d{4}-\d{2}-\d{2})__(.+)$/);
  if (m) return { key: `${m[1]!}_${m[2]!}`, catalogBaseName: m[2]! };
  return { key: stem, catalogBaseName: catalogBaseNameFromImageKey(stem) };
}

const db = initLibraryDb(libPath);

if (!existsSync(PROTOTYPE_IMG)) {
  console.error(`Prototype images missing: ${PROTOTYPE_IMG}`);
  process.exit(1);
}

const files = readdirSync(PROTOTYPE_IMG)
  .filter((f) => f.toLowerCase().endsWith('.jpg'))
  .sort();

const ins = db.prepare('INSERT INTO images (key, filename, filepath) VALUES (?, ?, ?)');
const cacheIns = db.prepare(
  "INSERT OR IGNORE INTO vision_cache (key, compressed_path, phash, compressed_at, original_mtime) VALUES (?, ?, NULL, datetime('now'), 1)",
);

const keyByFile = new Map<string, string>();
for (const file of files) {
  const { key } = prototypeKeyAndBaseName(file);
  keyByFile.set(file, key);
  const dest = join(vision, file);
  copyFileSync(join(PROTOTYPE_IMG, file), dest);
  ins.run(key, file, dest);
  cacheIns.run(key, dest);
}

const pipe = getCurrentPipelineSetting(db);
const layaModelIds = { base: 'laya-base', new: 'laya-new' };
const stages = resolveCurrentStages(db, pipe.config, layaModelIds);
const stageByKey = new Map(stages.map((s) => [s.stageKey, s]));
const recipe7 = stageByKey.get('culling_recipe:recipe-7h47:7');
const recipe10 = stageByKey.get('culling_recipe:recipe-7h47:10');
const scoreForecast = stageByKey.get('score_forecast');
if (!recipe7 || !recipe10 || !scoreForecast) throw new Error('Expected cull stages missing');

const runId = insertCullRun(db, {
  kind: 'job',
  jobId: null,
  pipelineSettingVersion: pipe.version,
  detail: { seeded: true },
});
finishCullRun(db, runId, { total: files.length });

const stageVersionIds = stages.map((s) => s.versionId);

function baseVerdict(
  imageKey: string,
  partial: Partial<CullVerdictInput> & Pick<CullVerdictInput, 'verdict'>,
): CullVerdictInput {
  return {
    imageKey,
    cutBy: null,
    cutByStageKey: null,
    sentByHand: false,
    pendingStages: [],
    pendingReason: '',
    scoreForecastOff: false,
    scoreForecastP8: null,
    pipelineSettingVersion: pipe.version,
    stageVersionIds,
    runId,
    ...partial,
  };
}

function seedStageAnswers(
  imageKey: string,
  opts: { recipeLevel?: number; forecastHigh?: boolean; recipe10?: boolean },
): void {
  if (opts.recipeLevel !== undefined) {
    upsertStageAnswer(db, {
      imageKey,
      stageVersionId: recipe7.versionId,
      answers: recipeAnswers('7', opts.recipeLevel),
      verdict: 'cut',
      decision: {},
      pipelineSettingVersion: pipe.version,
      source: 'job',
      runId,
    });
    if (opts.recipe10) {
      upsertStageAnswer(db, {
        imageKey,
        stageVersionId: recipe10.versionId,
        answers: recipeAnswers('10', opts.recipeLevel),
        verdict: 'cut',
        decision: {},
        pipelineSettingVersion: pipe.version,
        source: 'job',
        runId,
      });
    }
  }
  if (opts.forecastHigh !== undefined) {
    upsertStageAnswer(db, {
      imageKey,
      stageVersionId: scoreForecast.versionId,
      answers: forecastAnswers(scoreForecast, opts.forecastHigh),
      verdict: opts.forecastHigh ? 'sent' : 'cut',
      decision: {},
      pipelineSettingVersion: pipe.version,
      source: 'job',
      runId,
    });
  }
}

files.forEach((file, i) => {
  const key = keyByFile.get(file)!;
  if (i < 3) {
    upsertCullVerdict(db, baseVerdict(key, { verdict: 'sent' }));
    seedStageAnswers(key, { recipeLevel: 6, forecastHigh: true, recipe10: true });
    return;
  }
  if (i === 3) {
    upsertCullVerdict(
      db,
      baseVerdict(key, {
        verdict: 'cut',
        cutBy: 'culling_recipe',
        cutByStageKey: 'culling_recipe:recipe-7h47:7',
        scoreForecastP8: 0.08,
      }),
    );
    seedStageAnswers(key, { recipeLevel: 1, forecastHigh: false, recipe10: true });
    recordCullUserAction(db, key, 'sent_by_hand');
    return;
  }
  if (i === 4) {
    upsertCullVerdict(
      db,
      baseVerdict(key, {
        verdict: 'cut',
        cutBy: 'culling_recipe',
        cutByStageKey: 'culling_recipe:recipe-7h47:7',
        scoreForecastP8: 0.15,
        pendingStages: ['score_forecast'],
        pendingReason: 'awaiting forecast',
      }),
    );
    seedStageAnswers(key, { recipeLevel: 1, recipe10: true });
    return;
  }
  if (i === 5) {
    upsertCullVerdict(
      db,
      baseVerdict(key, {
        verdict: 'cut',
        cutBy: 'culling_recipe',
        cutByStageKey: 'culling_recipe:recipe-7h47:7',
        scoreForecastP8: 0.12,
      }),
    );
    seedStageAnswers(key, { recipeLevel: 2, forecastHigh: false, recipe10: true });
    recordCullUserAction(db, key, 'agrees_with_cut');
    return;
  }
  if (i >= 6 && i < 28) {
    const byForecast = i >= 20;
    upsertCullVerdict(
      db,
      baseVerdict(key, {
        verdict: 'cut',
        cutBy: byForecast ? 'score_forecast' : 'culling_recipe',
        cutByStageKey: byForecast ? 'score_forecast' : 'culling_recipe:recipe-7h47:7',
        scoreForecastP8: byForecast ? 0.06 + (i % 5) * 0.02 : 0.14 + (i % 4) * 0.03,
      }),
    );
    if (byForecast) {
      seedStageAnswers(key, { recipeLevel: 4, forecastHigh: false, recipe10: i % 3 === 0 });
    } else {
      seedStageAnswers(key, { recipeLevel: i % 2 === 0 ? 1 : 2, forecastHigh: false, recipe10: true });
    }
    return;
  }
  if (i === 28) {
    upsertCullVerdict(
      db,
      baseVerdict(key, {
        verdict: 'cut',
        cutBy: 'culling_recipe',
        cutByStageKey: 'culling_recipe:recipe-7h47:7',
        scoreForecastP8: 0.09,
      }),
    );
    seedStageAnswers(key, { recipeLevel: 1, forecastHigh: false });
    return;
  }
  if (i === 29) {
    upsertCullVerdict(
      db,
      baseVerdict(key, {
        verdict: 'cut',
        cutBy: 'culling_recipe',
        cutByStageKey: 'culling_recipe:recipe-7h47:7',
        scoreForecastP8: 0.11,
      }),
    );
    seedStageAnswers(key, { recipeLevel: 2, forecastHigh: false });
    const perspectives = db
      .prepare('SELECT slug, prompt_markdown FROM perspectives WHERE active = 1 LIMIT 2')
      .all() as { slug: string; prompt_markdown: string }[];
    db.prepare(
      `INSERT INTO image_descriptions (image_key, image_type, summary, model_used, described_at)
       VALUES (?, 'catalog', 'seed', 'test', datetime('now'))`,
    ).run(key);
    if (perspectives[0]) {
      db.prepare(
        `INSERT INTO image_scores (image_key, image_type, perspective_slug, score, rationale, model_used, prompt_version, scored_at, is_current, repaired_from_malformed, not_attempted)
         VALUES (?, 'catalog', ?, 6, '', 'test', ?, datetime('now'), 1, 0, 0)`,
      ).run(key, perspectives[0].slug, computePromptVersion(perspectives[0]));
    }
    return;
  }
  if (i === 30) {
    upsertCullVerdict(
      db,
      baseVerdict(key, {
        verdict: 'cut',
        cutBy: 'score_forecast',
        cutByStageKey: 'score_forecast',
        scoreForecastP8: 0.07,
      }),
    );
    seedStageAnswers(key, { recipeLevel: 3, forecastHigh: false });
    const perspectives = db
      .prepare('SELECT slug, prompt_markdown FROM perspectives WHERE active = 1')
      .all() as { slug: string; prompt_markdown: string }[];
    db.prepare(
      `INSERT INTO image_descriptions (image_key, image_type, summary, model_used, described_at)
       VALUES (?, 'catalog', 'seed', 'test', datetime('now'))`,
    ).run(key);
    for (const p of perspectives) {
      db.prepare(
        `INSERT INTO image_scores (image_key, image_type, perspective_slug, score, rationale, model_used, prompt_version, scored_at, is_current, repaired_from_malformed, not_attempted)
         VALUES (?, 'catalog', ?, 7, '', 'test', ?, datetime('now'), 1, 0, 0)`,
      ).run(key, p.slug, computePromptVersion(p));
    }
    db.prepare('DELETE FROM vision_stale WHERE image_key = ?').run(key);
    return;
  }
  upsertCullVerdict(
    db,
    baseVerdict(key, {
      verdict: 'cut',
      cutBy: 'culling_recipe',
      cutByStageKey: 'culling_recipe:recipe-7h47:7',
      scoreForecastP8: 0.05 + (i % 7) * 0.015,
    }),
  );
  seedStageAnswers(key, { recipeLevel: 1, forecastHigh: false, recipe10: i % 2 === 0 });
});

const lrcatPath = join(tmpRoot, 'review.lrcat');
const imageRows = db
  .prepare('SELECT key, filename FROM images ORDER BY key LIMIT 80')
  .all() as { key: string; filename: string }[];
makeFakeCatalog(
  lrcatPath,
  imageRows.map((row, idx) => ({
    id: idx + 1,
    baseName: catalogBaseNameFromImageKey(row.key),
    pick: idx === 5 ? 1 : idx === 6 ? -1 : 0,
    rating: idx === 7 ? 4 : null,
  })),
);
patchLrWritebackSettings(db, { write_stars: true, write_reject: true });
if (process.env.LT_CONFIG_YAML) {
  writeFileSync(
    process.env.LT_CONFIG_YAML,
    readFileSync(process.env.LT_CONFIG_YAML, 'utf8').replace(
      /catalog_path: .*/,
      `catalog_path: ${lrcatPath}`,
    ),
  );
}

db.close();
console.log(`Seeded ${libPath} with ${files.length} photos from prototype`);
console.log(`Temp catalog: ${lrcatPath}`);
