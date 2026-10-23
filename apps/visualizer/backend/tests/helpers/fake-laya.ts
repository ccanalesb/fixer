/**
 * Shared fake Laya runtime for job-handler tests: call log, start/close counts, and
 * `vi.mock('../src/laya/runtime.js', …)` wiring. Never loads real models; everything above the worker —
 * the System One client, this app's endpoint and its model list — is real.
 *
 * The runtime sees image bytes only, so test photos carry their key in EXIF (`writeFakePhoto`).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import type { LayaQuestion } from '../../src/laya/rows.js';

/** Per photo file: profile levels and highest P(≥ 8) for the forecast stage. */
export interface FakeLayaScript {
  levels: [number, number, number, number];
  p8: number;
}

export interface FakeLayaCall {
  /** `/<key>.jpg`, the photo the bytes came from. */
  file: string;
  /** The installed model's name (`laya-base`, `laya-new`). */
  model: string;
  /** Question ids asked, `<stage key>#<question id>`. */
  questions: string[];
}

export interface FakeLayaState {
  scripts: Map<string, FakeLayaScript>;
  calls: FakeLayaCall[];
  /** Start checks: images with no photo key. */
  checks: number;
  starts: number;
  closed: number;
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
    checks: 0,
    starts: 0,
    closed: 0,
    failOn: null,
    dieOn: null,
    broken: false,
    startError: null,
    cancelAfter: null,
    sequence: [],
  };
}

const MARK = /fake-photo:([^;]+);/;

/** The photo key `writeFakePhoto` put in the image; null for any other image (a start check). */
export function fakePhotoKey(image: Uint8Array): string | null {
  return MARK.exec(Buffer.from(image).toString('latin1'))?.[1] ?? null;
}

/** The 8×8 JPEG the tests always wrote, with the photo's key in EXIF. */
export async function writeFakePhoto(path: string, key: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .jpeg()
    .withExif({ IFD0: { ImageDescription: `fake-photo:${key};` } })
    .toFile(path);
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

/** config.yaml lines putting each culling stage on this app's Laya base and Laya new (a new install has no model). */
export const THIS_APP_LAYA_YAML =
  'culling_models:\n' +
  '  culling_profile: {endpoint: this_app, model: laya-base, api_key: ""}\n' +
  '  score_forecast: {endpoint: this_app, model: laya-new, api_key: ""}\n';

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

const DIMS = ['immediate-impact', 'visual-structure', 'point-of-tension', 'connotation'];

/** Level `l` (1-based) as a one-hot over `n` levels. */
const at = (level: number, n: number) => Array.from({ length: n }, (_, i) => (i === level - 1 ? 1 : 0));
/** Level `l` of 10 lands on 7 levels at the same position on the scale, as the research maps them. */
const on7 = (l: number) => Math.round(1 + ((l - 1) * 6) / 9);

const DEFAULT_SCRIPT: FakeLayaScript = { levels: [5, 5, 5, 5], p8: 0.5 };

/** What the fake answers for photo `key`: its script, level 5 everywhere when it has none. */
export function scriptedAnswers(
  state: FakeLayaState,
  key: string | null,
  questions: Record<string, LayaQuestion>,
): Record<string, number[]> {
  const s = (key !== null && state.scripts.get(key)) || DEFAULT_SCRIPT;
  return Object.fromEntries(Object.entries(questions).map(([qid, q]) => [qid, scriptedAnswer(s, qid, q)]));
}

function scriptedAnswer(s: FakeLayaScript, qid: string, q: LayaQuestion): number[] {
  const own = qid.slice(qid.indexOf('#') + 1);
  if (own.includes('|')) {
    const [set, dim] = own.split('|');
    const l = s.levels[DIMS.indexOf(dim!)]!;
    return set === '7' ? at(on7(l), 7) : at(l, 10);
  }
  if (own === 'framing-excusal') return [0.9, 0.1];
  if (own === 'framing') return [0, 0, 0, 0, 0, 0, 0, 0.99, 0, 0];
  if (own === 'intensity-suggestion') return [1 - s.p8, 0, 0, 0, 0, 0, 0, s.p8, 0, 0];
  const k = q.type === 'noul' ? 2 : Array.isArray(q.criteria) ? q.criteria.length : Object.keys(q.criteria ?? {}).length;
  return at(1, k);
}

/** Vitest mock factory for `src/laya/runtime.js`. */
export function fakeLayaRuntimeModule(
  actual: typeof import('../../src/laya/runtime.js'),
  state: FakeLayaState,
): typeof import('../../src/laya/runtime.js') {
  return {
    ...actual,
    startLayaRuntime: async () => {
      state.starts += 1;
      if (state.startError) throw state.startError;
      return {
        get broken() {
          return state.broken;
        },
        async answer(model, image, questions) {
          const key = fakePhotoKey(image);
          if (key === null) state.checks += 1;
          else {
            state.sequence.push(`laya:${key}`);
            state.calls.push({ file: `/${key}.jpg`, model: model.name, questions: Object.keys(questions) });
          }
          if (state.broken) throw new Error('Laya worker exited (code 1)');
          if (key !== null && state.dieOn === key) {
            state.broken = true;
            throw new Error('Laya worker exited (code 1)');
          }
          if (key !== null && state.failOn === key) throw new Error('decode failed');
          const answers = scriptedAnswers(state, key, questions);
          if (key !== null) state.cancelAfter?.();
          return { answers, seconds: { prep: 0.1, vision: 0.2, decoder: 0.3, total: 0.6 }, inputTokens: 1 };
        },
        async close() {
          state.closed += 1;
        },
      };
    },
  };
}
