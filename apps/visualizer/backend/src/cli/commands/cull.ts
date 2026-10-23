/**
 * `cull-check` — culling's start check, by hand: each stage's endpoint and model from `config.yaml`,
 * its model identity, and the default pipeline setting's questions answered on a test image. With
 * `--photo`, also prints each stage's level probabilities for that photo.
 */
import { systemOneApp } from '../../api/systemone.js';
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
import { THIS_APP_ENDPOINT } from '../../systemone/client.js';
import { stringFlag } from '../parse.js';
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
      ctx.out(`${STAGE_NAMES[kind]}: ${m.model || 'no model'} on ${m.endpoint.label}`);
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
