/**
 * Laya in Node vs the PyTorch reference the setup step wrote next to the models
 * (`<model>/reference/`): token rows, pixel values, probabilities through this app's System One
 * endpoint; and the event loop while it answers.
 *
 * Needs the exported models, so it skips unless LT_LAYA_PARITY=1:
 *
 *   uv run scripts/laya/export_onnx.py --laya-new <checkpoint>   # once, from the repo root
 *   LT_LAYA_PARITY=1 npx vitest run tests/laya-parity.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { config, loadLibraryConfig } from '../src/config.js';
import { referencePhotoPath, resolveLayaModelFiles } from '../src/laya/files.js';
import { closeAppModels } from '../src/laya/app-models.js';
import { LAYA_QUESTIONS, type LayaModelName } from '../src/laya/questions.js';
import { buildModelRows, loadLayaPixelValues } from '../src/laya/sessions.js';
import { askSystemOne, systemOneEndpoint } from '../src/systemone/client.js';

const modelsDir = loadLibraryConfig(config.LT_CONFIG_YAML).layaModelsDir;
const enabled = process.env.LT_LAYA_PARITY === '1' && existsSync(join(modelsDir, 'laya-base'));
const describeMaybe = enabled ? describe : describe.skip;

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

describeMaybe('Laya parity with the PyTorch reference', () => {
  const files = enabled ? resolveLayaModelFiles(modelsDir) : { baseDir: '', newDir: null };
  const models: [LayaModelName, string][] = enabled
    ? [['base', files.baseDir], ...(files.newDir ? [['new', files.newDir] as [LayaModelName, string]] : [])]
    : [];

  it.each(models)('Laya %s token rows equal Python’s', (name, dir) => {
    type Ref = { ids: number[]; markers: number[]; option_span: number[]; qtype: number };
    const ref = readJson<Record<string, Ref>>(join(dir, 'reference', 'rows.json'));
    const { rows } = buildModelRows(dir, name);
    expect(rows.map((r) => r.qid)).toEqual(Object.keys(ref));
    for (const r of rows) {
      const p = ref[r.qid]!;
      expect({ ids: r.ids, markers: r.markers, span: r.optionSpan, qtype: r.qtype }).toEqual({
        ids: p.ids,
        markers: p.markers,
        span: p.option_span,
        qtype: p.qtype,
      });
    }
  });

  it('pixel values are within one level of 255 of the Idefics3 processor', async () => {
    const ref = new Float32Array(readFileSync(join(files.baseDir, 'reference', 'pixel_values.f32')).buffer.slice(0));
    const got = await loadLayaPixelValues(referencePhotoPath(files));
    expect(got.length).toBe(ref.length);
    let max = 0;
    for (let i = 0; i < got.length; i++) max = Math.max(max, Math.abs(got[i]! - ref[i]!) * 127.5);
    expect(max).toBeLessThanOrEqual(1.01);
  });

  afterAll(() => closeAppModels());

  it('answers in a worker thread, within 0.01 of PyTorch, without holding the main event loop', async () => {
    const lag = monitorEventLoopDelay({ resolution: 5 });
    const ep = systemOneEndpoint({ endpoint: 'this_app', model: '', apiKey: '' });
    const image = new Uint8Array(readFileSync(referencePhotoPath(files)));
    const ask = (name: LayaModelName) => askSystemOne(ep, { model: `laya-${name}`, image, questions: LAYA_QUESTIONS[name] });
    // One window for every call, the worker's start included: a histogram enabled twice counts the gap.
    lag.enable();
    for (const [name, dir] of models) {
      const got = await ask(name);
      const ref = readJson<Record<string, number[]>>(join(dir, 'reference', 'probabilities.json'));
      for (const [qid, p] of Object.entries(ref)) {
        const diff = Math.max(...p.map((v, i) => Math.abs(v - got[qid]![i]!)));
        expect(diff, `${name} ${qid}`).toBeLessThan(0.01);
      }
      expect(await ask(name)).toEqual(got);
    }
    lag.disable();
    expect(lag.max / 1e6).toBeLessThan(200);
  }, 60_000);
});
