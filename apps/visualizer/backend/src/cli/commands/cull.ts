/**
 * `cull-check` — the cull's start check, by hand: Laya's files, load, the reference photo answered.
 * With `--photo`, also prints Laya's level probabilities for that photo.
 *
 * `cull-import` — the research runs as the first stored cull answers (`cull/import-research.ts`).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { importResearchRuns } from '../../cull/import-research.js';
import { LayaSetupError } from '../../laya/files.js';
import { LAYA_BASE_RESEARCH_MODEL_ID, layaNewModelId } from '../../laya/model-id.js';
import { startLayaWithCheck, type LayaPhotoResult } from '../../laya/runtime.js';
import type { LayaModelAnswers } from '../../laya/sessions.js';
import { CliError, withLibraryDbAsync } from '../library-db.js';
import { boolFlag, stringFlag } from '../parse.js';
import type { CommandContext } from '../registry.js';

const s = (v: number) => v.toFixed(2);

function timing(r: LayaPhotoResult): string {
  const t = r.seconds;
  return `${s(t.total)} s (image ${s(t.prep)}, vision ${s(t.vision)}, Laya base ${s(t.base)}, Laya new ${s(t.new)})`;
}

function printAnswers(ctx: CommandContext, label: string, answers: LayaModelAnswers): void {
  for (const [qid, p] of Object.entries(answers)) {
    ctx.out(`  ${label} ${qid}: ${p.map((v) => v.toFixed(3)).join(' ')}`);
  }
}

export async function cmdCullCheck(ctx: CommandContext): Promise<number> {
  ctx.out(`Laya models: ${ctx.config.layaModelsDir}`);
  let check;
  try {
    check = await startLayaWithCheck(ctx.config.layaModelsDir);
  } catch (e) {
    if (!(e instanceof LayaSetupError)) throw e;
    ctx.out(e.message);
    return 1;
  }
  const { runtime } = check;
  try {
    ctx.out(`Score forecast: ${runtime.scoreForecastOn ? 'on' : 'off (no Laya new)'}`);
    ctx.out(`Loaded in ${s(check.loadSeconds)} s`);
    ctx.out(`Test photo answered in ${timing(check.testPhoto)}`);
    const photo = stringFlag(ctx.args, 'photo');
    if (photo) {
      const r = await runtime.answer(photo);
      ctx.out(`${photo} answered in ${timing(r)}`);
      printAnswers(ctx, 'Laya base', r.answers.base);
      if (r.answers.new) printAnswers(ctx, 'Laya new', r.answers.new);
    }
    return 0;
  } finally {
    await runtime.close();
  }
}

/**
 * Laya new has no revision: the research answers are filed under the exported decoder's hash, which
 * says they came from the same checkpoint the cull job runs. `--laya-new-model-id` names it by hand.
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
  const recipePath = stringFlag(ctx.args, 'recipe');
  if (!layaNewPath || !recipePath) {
    throw new CliError('cull-import needs --laya-new <laya_new_catalog.jsonl> and --recipe <laya_cull_catalog_all.jsonl>');
  }
  for (const p of [layaNewPath, recipePath]) if (!existsSync(p)) throw new CliError(`File not found: ${p}`);
  const modelIds = { base: LAYA_BASE_RESEARCH_MODEL_ID, new: await researchLayaNewModelId(ctx) };
  const dryRun = boolFlag(ctx.args, 'dry-run');
  return withLibraryDbAsync(ctx, { mustExist: true }, async (db, dbPath) => {
    ctx.out(`${dryRun ? 'Dry run: nothing is written. ' : ''}Importing the research runs into ${dbPath}`);
    ctx.out(`Laya base: ${modelIds.base}`);
    ctx.out(`Laya new: ${modelIds.new}`);
    const r = await importResearchRuns(db, { layaNewPath, recipePath, modelIds, dryRun });
    ctx.out(`Lines: Laya new ${r.lines.laya_new}, culling recipe ${r.lines.recipe}`);
    if (r.truncated_tail.recipe || r.truncated_tail.laya_new) {
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
      `Verdicts: cut by the culling recipe ${v.cut_by_culling_recipe}, cut by the Score forecast ` +
        `${v.cut_by_score_forecast}, pending ${v.pending}, sent ${v.sent}`,
    );
    return 0;
  });
}
