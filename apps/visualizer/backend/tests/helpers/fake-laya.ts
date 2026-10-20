/**
 * Shared fake Laya runtime for job-handler tests: call log, start/close counts, and
 * `vi.mock('../src/laya/runtime.js', …)` wiring. Never loads real models.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LayaAnswerWant } from '../../src/laya/sessions.js';

/** Per photo file: recipe levels and highest P(≥ 8) for the forecast stage. */
export interface FakeLayaScript {
  levels: [number, number, number, number];
  p8: number;
}

export interface FakeLayaState {
  scripts: Map<string, FakeLayaScript>;
  calls: { file: string; want: LayaAnswerWant | undefined }[];
  starts: number;
  closed: number;
  forecastOn: boolean;
  failOn: null | string;
  dieOn: null | string;
  broken: boolean;
  startError: null | Error;
  cancelAfter: null | (() => void);
  /** Ordering probe: tests push `laya:<key>` from the mock answer handler. */
  sequence: string[];
}

export function fakeLayaState(): FakeLayaState {
  return {
    scripts: new Map(),
    calls: [],
    starts: 0,
    closed: 0,
    forecastOn: true,
    failOn: null,
    dieOn: null,
    broken: false,
    startError: null,
    cancelAfter: null,
    sequence: [],
  };
}

function writeMinimalLayaTokenizer(dir: string): void {
  mkdirSync(join(dir, 'tokenizer'), { recursive: true });
  const vocab: Record<string, number> = {};
  for (let i = 0; i < 256; i += 1) vocab[String.fromCharCode(i)] = i + 1;
  writeFileSync(join(dir, 'tokenizer', 'tokenizer.json'), JSON.stringify({ model: { vocab } }));
  writeFileSync(join(dir, 'tokenizer', 'tokenizer_config.json'), '{}');
  writeFileSync(
    join(dir, 'model.json'),
    JSON.stringify({
      temperature: [1, 1, 1],
      temperature_by_options: {},
      max_len: 512,
      head_max_len: 128,
      image_token_id: 1,
      pad_token_id: 0,
      prefix_ids: [1, 2, 3],
      source: 'thaitea/laya-vision',
      revision: '8b318c99d7ad3ce19c24369263463882eada9d1e',
    }),
  );
}

export function writeFakeLayaModels(modelsDir: string, opts: { withNew?: boolean } = {}): void {
  const withNew = opts.withNew !== false;
  const base = join(modelsDir, 'laya-base');
  mkdirSync(join(base, 'reference'), { recursive: true });
  for (const f of ['vision.onnx', 'decoder.onnx', 'reference/photo.png']) {
    writeFileSync(join(base, f), '');
  }
  writeMinimalLayaTokenizer(base);
  if (!withNew) return;
  const neu = join(modelsDir, 'laya-new');
  mkdirSync(join(neu, 'tokenizer'), { recursive: true });
  for (const f of ['decoder.onnx', 'tokenizer/tokenizer.json', 'tokenizer/tokenizer_config.json']) {
    writeFileSync(join(neu, f), 'x');
  }
  writeFileSync(join(neu, 'model.json'), JSON.stringify({ source: '/somewhere/best', revision: null }));
}

/** Vitest mock factory for `src/laya/runtime.js`. */
export function fakeLayaRuntimeModule(
  actual: typeof import('../../src/laya/runtime.js'),
  state: FakeLayaState,
): typeof import('../../src/laya/runtime.js') {
  const at = (level: number, n: number) => Array.from({ length: n }, (_, i) => (i === level - 1 ? 1 : 0));
  const on7 = (l: number) => Math.round(1 + ((l - 1) * 6) / 9);
  const runtime = {
    get scoreForecastOn() {
      return state.forecastOn;
    },
    get broken() {
      return state.broken;
    },
    async answer(file: string, want?: LayaAnswerWant) {
      const key = [...state.scripts.keys()].find((k) => file.endsWith(`/${k}.jpg`));
      if (key) state.sequence.push(`laya:${key}`);
      state.calls.push({ file, want });
      if (state.broken) throw new Error('Laya worker exited (code 1)');
      if (state.dieOn && file.endsWith(`/${state.dieOn}.jpg`)) {
        state.broken = true;
        throw new Error('Laya worker exited (code 1)');
      }
      if (state.failOn && file.endsWith(`/${state.failOn}.jpg`)) throw new Error('decode failed');
      const s = [...state.scripts.entries()].find(([k]) => file.endsWith(`/${k}.jpg`))?.[1] ?? {
        levels: [5, 5, 5, 5] as [number, number, number, number],
        p8: 0.5,
      };
      const dims = ['immediate-impact', 'visual-structure', 'point-of-tension', 'connotation'];
      const base: Record<string, number[]> = {};
      for (const qid of want?.base ?? []) {
        const [, rest] = qid.split('#');
        const [set, dim] = rest!.split('|');
        const l = s.levels[dims.indexOf(dim!)]!;
        base[qid] = set === '7' ? at(on7(l), 7) : at(l, 10);
      }
      const neu =
        want?.new && state.forecastOn
          ? {
              'framing-excusal': [0.9, 0.1],
              framing: [0, 0, 0, 0, 0, 0, 0, 0.99, 0, 0],
              'intensity-suggestion': [1 - s.p8, 0, 0, 0, 0, 0, 0, s.p8, 0, 0],
            }
          : null;
      state.cancelAfter?.();
      return {
        answers: { base, new: neu },
        seconds: { prep: 0.1, vision: 0.2, base: 0.3, new: 0.4, total: 1 },
      };
    },
    async close() {
      state.closed += 1;
    },
  };
  return {
    ...actual,
    startLayaWithCheck: async () => {
      state.starts += 1;
      if (state.startError) throw state.startError;
      return {
        runtime: runtime as unknown as import('../../src/laya/runtime.js').LayaRuntime,
        loadSeconds: 0.5,
        testPhoto: {
          answers: { base: {}, new: null },
          seconds: { prep: 0, vision: 0, base: 0, new: 0, total: 0 },
        },
      };
    },
  };
}

