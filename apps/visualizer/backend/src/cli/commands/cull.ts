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
  stageModelsFrom,
} from '../../cull/stage-models.js';
import { resolveStages, throwIfStageProblem } from '../../cull/stage-resolver.js';
import type { StageKind } from '../../cull/types.js';
import { syncCurrentStages } from '../../db/library/cull-sync-stages.js';
import { initLibraryDb } from '../../db/library/bootstrap.js';
import { AppModels } from '../../app-models/app-models.js';
import { installedModels } from '../../app-models/files.js';
import type { AppModelStatus } from '../../app-models/install.js';
import { THIS_APP_ENDPOINT } from '../../systemone/client.js';
import { stringFlag } from '../parse.js';
import type { CommandContext } from '../registry.js';

const s = (v: number) => v.toFixed(2);
const KINDS: StageKind[] = ['culling_profile', 'score_forecast'];

export async function cmdCullCheck(ctx: CommandContext): Promise<number> {
  const local = new AppModels(() => ctx.config.appModelsDir);
  const app = systemOneApp(() => local);
  const thisAppFetch: typeof fetch = async (input, init) => app.request(input instanceof URL ? input.href : input, init);
  const on = { culling_profile: true, score_forecast: true };
  const appModels: AppModelStatus[] = installedModels(ctx.config.appModelsDir).map((m) => ({
    name: m.name,
    source: m.source,
    revision: m.revision,
    status: 'ready',
    job_id: m.jobId,
  }));
  const db = initLibraryDb(':memory:');
  try {
    const resolved = resolveStages({ on, cfg: ctx.config.cullingModels, appModels, questionCount: 0, thisAppFetch });
    const models = stageModelsFrom(resolved);
    for (const kind of KINDS) {
      const label = resolved[kind].systemOne?.label ?? resolved[kind].endpoint;
      ctx.out(`${STAGE_NAMES[kind]}: ${models[kind].model || 'no model'} on ${label}`);
    }
    if (KINDS.some((k) => models[k].endpoint?.id === THIS_APP_ENDPOINT)) {
      ctx.out(`This app's models: ${ctx.config.appModelsDir}`);
    }
    throwIfStageProblem(resolved, { skip: new Set(['no_questions']) });
    const ids = await resolveStageModelIds(models, on, { culling_profile: null, score_forecast: null });
    for (const kind of KINDS) ctx.out(`  ${STAGE_NAMES[kind]} model identity: ${ids[kind]}`);
    const stages = syncCurrentStages(db, ids);
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
