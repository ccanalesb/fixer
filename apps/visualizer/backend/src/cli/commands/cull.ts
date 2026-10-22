/**
 * `cull-check` — culling's start check, by hand: each stage's endpoint and model from `config.yaml`,
 * its model identity, and the default pipeline setting's questions answered on a test image. With
 * `--photo`, also prints each stage's level probabilities for that photo.
 *
 * `cull-import` — the research runs as the first stored cull answers (`cull/import-research.ts`).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { systemOneApp } from '../../api/systemone.js';
import { importResearchRuns } from '../../cull/import-research.js';
import {
  CullingModels,
  CullingStageError,
  resolveStageModelIds,
  STAGE_NAMES,
  stageModelsFromConfig,
} from '../../cull/stage-models.js';
import { resolveCurrentStages } from '../../cull/stages.js';
import type { StageKind } from '../../cull/types.js';
import { initLibraryDb } from '../../db/library/bootstrap.js';
import { getCurrentPipelineSetting } from '../../db/library/cull-pipeline.js';
import { AppModels } from '../../laya/app-models.js';
import { LAYA_BASE_RESEARCH_MODEL_ID, layaNewModelId } from '../../laya/model-id.js';
import { THIS_APP_ENDPOINT } from '../../systemone/client.js';
import { CliError, withLibraryDbAsync } from '../library-db.js';
import { boolFlag, stringFlag } from '../parse.js';
import type { CommandContext } from '../registry.js';

const s = (v: number) => v.toFixed(2);
const KINDS: StageKind[] = ['culling_profile', 'score_forecast'];

export async function cmdCullCheck(ctx: CommandContext): Promise<number> {
  const local = new AppModels(() => ctx.config.layaModelsDir);
  const app = systemOneApp(() => local);
  const thisAppFetch: typeof fetch = async (input, init) => app.request(input instanceof URL ? input.href : input, init);
  const models = stageModelsFromConfig(ctx.config.cullingModels, { thisAppFetch });
  // The default pipeline setting, in a throwaway library: the questions a fresh library's job asks.
  const db = initLibraryDb(':memory:');
  try {
    for (const kind of KINDS) {
      const m = models[kind];
      ctx.out(`${STAGE_NAMES[kind]}: ${m.model} on ${m.endpoint.label}`);
    }
    if (KINDS.some((k) => models[k].endpoint.id === THIS_APP_ENDPOINT)) {
      ctx.out(`This app's models: ${ctx.config.layaModelsDir}`);
    }
    const ids = await resolveStageModelIds(
      models,
      { culling_profile: true, score_forecast: true },
      { culling_profile: null, score_forecast: null },
    );
    for (const kind of KINDS) ctx.out(`  ${STAGE_NAMES[kind]} model identity: ${ids[kind]}`);
    const stages = resolveCurrentStages(db, getCurrentPipelineSetting(db).config, ids);
    const check = new CullingModels(models, stages);
    const photo = stringFlag(ctx.args, 'photo');
    await check.check();
    ctx.out(`Start check answered in ${s(check.loadSeconds)} s`);
    if (photo) {
      const r = await check.answer(photo, stages);
      for (const kind of KINDS) ctx.out(`${photo}: ${STAGE_NAMES[kind]} answered in ${s(r.seconds[kind] ?? 0)} s`);
      for (const st of stages) {
        for (const [q, p] of Object.entries(r.answers[st.stageKey] ?? {})) {
          ctx.out(`  ${st.stageKey} ${q}: ${p.map((v) => v.toFixed(3)).join(' ')}`);
        }
      }
    }
    return 0;
  } catch (e) {
    if (!(e instanceof CullingStageError)) throw e;
    ctx.out(e.message);
    return 1;
  } finally {
    db.close();
    await local.close();
  }
}

/**
 * Laya new has no revision: the research answers are filed under the exported decoder's hash, which
 * says they came from the same checkpoint the culling job runs. `--laya-new-model-id` names it by hand.
 */
async function researchLayaNewModelId(ctx: CommandContext): Promise<string> {
  const given = stringFlag(ctx.args, 'laya-new-model-id');
  if (given) return given;
  const dir = join(ctx.config.layaModelsDir, 'laya-new');
  if (!existsSync(join(dir, 'decoder.onnx'))) {
    throw new CliError(
      `No Laya new export in ${dir}: run the setup step, or name the model with --laya-new-model-id`,
    );
  }
  return layaNewModelId(dir);
}

export async function cmdCullImport(ctx: CommandContext): Promise<number> {
  const layaNewPath = stringFlag(ctx.args, 'laya-new');
  const profilePath = stringFlag(ctx.args, 'culling-profile');
  if (!layaNewPath || !profilePath) {
    throw new CliError(
      'cull-import needs --laya-new <laya_new_catalog.jsonl> and --culling-profile <laya_cull_catalog_all.jsonl>',
    );
  }
  for (const p of [layaNewPath, profilePath]) if (!existsSync(p)) throw new CliError(`File not found: ${p}`);
  const modelIds = { base: LAYA_BASE_RESEARCH_MODEL_ID, new: await researchLayaNewModelId(ctx) };
  const dryRun = boolFlag(ctx.args, 'dry-run');
  return withLibraryDbAsync(ctx, { mustExist: true }, async (db, dbPath) => {
    ctx.out(`${dryRun ? 'Dry run: nothing is written. ' : ''}Importing the research runs into ${dbPath}`);
    ctx.out(`Laya base: ${modelIds.base}`);
    ctx.out(`Laya new: ${modelIds.new}`);
    const r = await importResearchRuns(db, { layaNewPath, profilePath, modelIds, dryRun });
    ctx.out(`Lines: Laya new ${r.lines.laya_new}, culling profile ${r.lines.profile}`);
    if (r.truncated_tail.profile || r.truncated_tail.laya_new) {
      ctx.out('Skipped a half-written last line: the file is still being written. Import again when it is done.');
    }
    ctx.out(`Photos: ${r.photos} in the library, ${r.missing_from_library} not in it`);
    if (r.missing_keys_sample.length > 0) ctx.out(`  not in the library: ${r.missing_keys_sample.join(', ')}`);
    if (r.partial > 0) ctx.out(`Skipped ${r.partial} incomplete answers`);
    for (const stage of Object.keys({ ...r.inserted, ...r.already_stored }).sort()) {
      ctx.out(`  ${stage}: ${r.inserted[stage] ?? 0} new, ${r.already_stored[stage] ?? 0} already stored`);
    }
    const v = r.verdicts;
    ctx.out(
      `Verdicts: filtered by the culling profile ${v.filtered_by_culling_profile}, filtered by the Score forecast ` +
        `${v.filtered_by_score_forecast}, pending ${v.pending}, passed ${v.passed}`,
    );
    return 0;
  });
}
