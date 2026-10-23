/**
 * Laya in Node vs the PyTorch reference the conversion wrote next to each installed model
 * (`<model>/reference/`): token rows, pixel values, probabilities through this app's System One
 * endpoint; and the event loop while it answers.
 *
 * Needs installed models, so it skips unless LT_LAYA_PARITY=1:
 *
 *   uv run scripts/laya/export_onnx.py thaitea/laya-vision --name laya-base   # once, from the repo root
 *   LT_LAYA_PARITY=1 npx vitest run tests/laya-parity.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { config, loadLibraryConfig } from '../src/config.js';
import { installedModels, referenceImageDir, type InstalledModel } from '../src/laya/files.js';
import { closeAppModels } from '../src/laya/app-models.js';
import { LAYA_QUESTIONS } from '../src/laya/questions.js';
import type { LayaQuestion } from '../src/laya/rows.js';
import { buildModelRows, loadLayaPixelValues } from '../src/laya/sessions.js';
import { askSystemOne, systemOneEndpoint } from '../src/systemone/client.js';

const modelsDir = loadLibraryConfig(config.LT_CONFIG_YAML).layaModelsDir;
const models = process.env.LT_LAYA_PARITY === '1' ? installedModels(modelsDir) : [];
const describeMaybe = models.length > 0 ? describe : describe.skip;

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const ALL_QUESTIONS: Record<string, LayaQuestion> = { ...LAYA_QUESTIONS.base, ...LAYA_QUESTIONS.new };

type RefRow = { ids: number[]; markers: number[]; option_span: number[]; qtype: number };

/** The questions the conversion asked: the reference's rows, in its order. */
function referenceQuestions(m: InstalledModel): Record<string, LayaQuestion> {
  const ref = readJson<Record<string, RefRow>>(join(m.dir, 'reference', 'rows.json'));
  return Object.fromEntries(Object.keys(ref).map((qid) => [qid, ALL_QUESTIONS[qid]!]));
}

const cases = models.map((m) => [m.name, m] as const);

describeMaybe('Laya parity with the PyTorch reference', () => {
  it.each(cases)('%s token rows equal Python’s', (_, m) => {
    const ref = readJson<Record<string, RefRow>>(join(m.dir, 'reference', 'rows.json'));
    const { rows } = buildModelRows(m.dir, referenceQuestions(m));
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

  it.each(cases)('%s pixel values are within one level of 255 of the Idefics3 processor', async (_, m) => {
    const dir = referenceImageDir(m);
    const ref = new Float32Array(readFileSync(join(dir, 'pixel_values.f32')).buffer.slice(0));
    const got = await loadLayaPixelValues(join(dir, 'photo.png'));
    expect(got.length).toBe(ref.length);
    let max = 0;
    for (let i = 0; i < got.length; i++) max = Math.max(max, Math.abs(got[i]! - ref[i]!) * 127.5);
    expect(max).toBeLessThanOrEqual(1.01);
  });

  afterAll(() => closeAppModels());

  it('answers in a worker thread, within 0.01 of PyTorch, without holding the main event loop', async () => {
    const lag = monitorEventLoopDelay({ resolution: 5 });
    const ep = systemOneEndpoint({ endpoint: 'this_app', model: '', apiKey: '' });
    // One window for every call, the worker's start included: a histogram enabled twice counts the gap.
    lag.enable();
    for (const m of models) {
      const image = new Uint8Array(readFileSync(join(referenceImageDir(m), 'photo.png')));
      const ask = () => askSystemOne(ep, { model: m.name, image, questions: referenceQuestions(m) });
      const got = await ask();
      const ref = readJson<Record<string, number[]>>(join(m.dir, 'reference', 'probabilities.json'));
      for (const [qid, p] of Object.entries(ref)) {
        const diff = Math.max(...p.map((v, i) => Math.abs(v - got[qid]![i]!)));
        expect(diff, `${m.name} ${qid}`).toBeLessThan(0.01);
      }
      expect(await ask()).toEqual(got);
    }
    lag.disable();
    expect(lag.max / 1e6).toBeLessThan(200);
  }, 120_000);
});
