/**
 * `cull-check` — the cull's start check, by hand: Laya's files, load, the reference photo answered.
 * With `--photo`, also prints Laya's level probabilities for that photo.
 */
import { LayaSetupError } from '../../laya/files.js';
import { startLayaWithCheck, type LayaPhotoResult } from '../../laya/runtime.js';
import type { LayaModelAnswers } from '../../laya/sessions.js';
import { stringFlag } from '../parse.js';
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
