/**
 * Laya's pure parts — image sizes, token rows, file check — with no model files.
 * Parity against the exported models is `laya-parity.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLibraryConfig } from '../src/config.js';
import { run } from '../src/cli/main.js';
import {
  LAYA_SETUP_COMMAND,
  LayaSetupError,
  installedModels,
  resolveInstalledModel,
  type InstalledModel,
} from '../src/laya/files.js';
import { rescaleToMaxLen, thumbnailSize } from '../src/laya/image.js';
import { buildRow, renderOptions, softmax, tempBucket, type LayaModelMeta } from '../src/laya/rows.js';
import { LAYA_QUESTIONS } from '../src/laya/questions.js';
import { installedModelId, layaNewModelId } from '../src/laya/model-id.js';

describe('image sizes', () => {
  // [width, height, thumbnail w, h, Idefics3 resize w, h], from PIL 12.3 and transformers 5.17.
  const PIL: [number, number, number, number, number, number][] = [
    [6000, 4000, 512, 341, 2048, 1364],
    [4000, 6000, 341, 512, 1364, 2048],
    [1200, 800, 512, 341, 2048, 1364],
    [513, 512, 512, 511, 2048, 2044],
    [512, 513, 511, 512, 2044, 2048],
    [4032, 3024, 512, 384, 2048, 1536],
    [1000, 999, 512, 511, 2048, 2044],
    [7952, 5304, 512, 342, 2048, 1368],
    [300, 200, 300, 200, 2048, 1366],
    [512, 512, 512, 512, 2048, 2048],
    [5, 3000, 1, 512, 4, 2048],
  ];

  it.each(PIL)('%ix%i matches PIL thumbnail and the Idefics3 resize', (w, h, tw, th, rw, rh) => {
    const thumb = thumbnailSize(w, h, 512) ?? [w, h];
    expect(thumb).toEqual([tw, th]);
    expect(rescaleToMaxLen(thumb[0], thumb[1], 2048)).toEqual([rw, rh]);
  });
});

describe('token rows', () => {
  /** One token per character; `\n` is a single token, as in Laya's tokenizer. */
  const encode = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
  const meta = (headMax: number): LayaModelMeta => ({
    temperature: [3, 2, 1.5],
    temperature_by_options: { 'score:3-5': 0.7 },
    max_len: 2000,
    head_max_len: headMax,
    image_token_id: 9,
    pad_token_id: 0,
    prefix_ids: [1, 9, 9, 9],
  });

  it('renders each question type the way laya does', () => {
    expect(renderOptions({ type: 'score', instructions: 'q', criteria: ['bad', 'good'] })).toEqual([
      'level 0: bad',
      'level 1: good',
    ]);
    expect(renderOptions({ type: 'choice', instructions: 'q', criteria: { a: 'first', b: null } })).toEqual([
      'a: first',
      'b',
    ]);
    expect(renderOptions({ type: 'noul', instructions: 'q' })).toEqual([
      'false: no, the statement does not hold',
      'true: yes, the statement holds',
    ]);
  });

  it('puts a marker on each option terminator and spans the options', () => {
    const r = buildRow(encode, meta(500), 'q1', { type: 'score', instructions: 'Is it?', criteria: ['x', 'y'] });
    const off = 4;
    const head = encode('\nscore question: Is it?<end_of_utterance>\nAssistant: Options:\n');
    const o1 = encode('- level 0: x');
    const o2 = encode('- level 1: y');
    expect(r.ids).toEqual([1, 9, 9, 9, ...head, ...o1, 10, ...o2, 10]);
    expect(r.markers).toEqual([off + head.length + o1.length, off + head.length + o1.length + 1 + o2.length]);
    expect(r.optionSpan).toEqual([off + head.length, r.ids.length]);
    expect(r.k).toBe(2);
    expect(r.temperature).toBe(2);
  });

  it('caps options at 48 tokens, then shrinks them and cuts the question in the middle past the budget', () => {
    const long = 'z'.repeat(100);
    const capped = buildRow(encode, meta(500), 'q', { type: 'score', instructions: 'q', criteria: [long] });
    expect(capped.markers[0]! - capped.optionSpan[0]).toBe(48);

    const tight = buildRow(encode, meta(60), 'q', {
      type: 'score',
      instructions: 'A'.repeat(200),
      criteria: [long, long, long],
    });
    const optTokens = tight.ids.length - tight.optionSpan[0];
    const headTokens = tight.optionSpan[0] - 4;
    expect(optTokens).toBe(3 * (Math.floor((60 - 16) / 3) - 1 + 1));
    expect(headTokens).toBe(Math.max(8, 60 - optTokens));
  });

  it('takes a per-option-count temperature when the checkpoint has one', () => {
    expect(tempBucket(1, 4)).toBe('score:3-5');
    const r = buildRow(encode, meta(500), 'q', { type: 'score', instructions: 'q', criteria: ['a', 'b', 'c'] });
    expect(r.temperature).toBe(0.7);
  });

  it('softmax sums to one and keeps order', () => {
    const p = softmax([1, 2, 3]);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(p[2]!).toBeGreaterThan(p[1]!);
  });

  it('ships the culling profile at 7 and 10 levels and Laya new’s five rows', () => {
    const dims = ['immediate-impact', 'visual-structure', 'point-of-tension', 'connotation'];
    expect(Object.keys(LAYA_QUESTIONS.base)).toEqual([...dims.map((d) => `7|${d}`), ...dims.map((d) => `10|${d}`)]);
    for (const d of dims) {
      expect(LAYA_QUESTIONS.base[`7|${d}`]!.criteria).toHaveLength(7);
      expect(LAYA_QUESTIONS.base[`10|${d}`]!.criteria).toHaveLength(10);
    }
    expect(Object.keys(LAYA_QUESTIONS.new)).toEqual([
      'framing-excusal',
      'framing',
      'compositional-cleanliness',
      'environmental-context-legibility',
      'intensity-suggestion',
    ]);
  });
});

describe('model files', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lt-laya-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const touch = (rel: string) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), '');
  };
  const DECODER_FILES = ['decoder.onnx', 'tokenizer/tokenizer.json', 'tokenizer/tokenizer_config.json'];
  const model = (name: string, meta: Record<string, unknown>, files = DECODER_FILES) => {
    files.forEach((f) => touch(`${name}/${f}`));
    writeFileSync(join(dir, name, 'model.json'), JSON.stringify(meta));
  };
  const base = () => {
    model('laya-base', { source: 'thaitea/laya-vision', revision: 'abc' }, [...DECODER_FILES, 'vision.onnx']);
  };
  const names = () => installedModels(dir).map((m) => [m.name, m.visionDir]);

  it('lists nothing before any model is installed, and a model asked for names the setup step', () => {
    expect(installedModels(dir)).toEqual([]);
    expect(installedModels(join(dir, 'nowhere'))).toEqual([]);
    expect(() => resolveInstalledModel(dir, 'laya-base')).toThrow(LayaSetupError);
    expect(() => resolveInstalledModel(dir, 'laya-base')).toThrow(LAYA_SETUP_COMMAND);
  });

  it('lists every complete model with the vision graph it reads', () => {
    base();
    model('laya-run-best', { source: '/x/laya-run/best', revision: null, vision: 'laya-base' });
    model('other', { source: 'someone/other', revision: 'def' }, [...DECODER_FILES, 'vision.onnx']);
    expect(names()).toEqual([
      ['laya-base', join(dir, 'laya-base')],
      ['laya-run-best', join(dir, 'laya-base')],
      ['other', join(dir, 'other')],
    ]);
    expect(resolveInstalledModel(dir, 'laya-run-best')).toMatchObject({
      dir: join(dir, 'laya-run-best'),
      source: '/x/laya-run/best',
      revision: null,
    });
  });

  it('reads the setup step’s earlier layout: Laya new without vision.onnx uses Laya base’s', () => {
    base();
    model('laya-new', { source: '/x/best', revision: null });
    expect(names()).toEqual([
      ['laya-base', join(dir, 'laya-base')],
      ['laya-new', join(dir, 'laya-base')],
    ]);
  });

  it('leaves out installs in progress and incomplete models; asking one names its missing files', () => {
    base();
    model('.install-laya-new', { source: '/x/best', revision: null, vision: 'laya-base' });
    touch('laya-new/decoder.onnx');
    model('orphan', { source: '/x/o', revision: null, vision: 'gone' });
    expect(names()).toEqual([['laya-base', join(dir, 'laya-base')]]);
    expect(() => resolveInstalledModel(dir, 'laya-new')).toThrow(join(dir, 'laya-new', 'model.json'));
    expect(() => resolveInstalledModel(dir, 'orphan')).toThrow(join(dir, 'gone', 'vision.onnx'));
  });

  it('cull-check exits 1 with the setup step when nothing is exported', async () => {
    const lines: string[] = [];
    const config = { ...loadLibraryConfig('/nonexistent/config.yaml'), layaModelsDir: dir };
    const code = await run(['cull-check'], { out: (l) => lines.push(l), config });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain(LAYA_SETUP_COMMAND);
  });

  it('reads laya_models_dir from config.yaml, defaulting to models/ in the repo', () => {
    expect(loadLibraryConfig('/nonexistent/config.yaml').layaModelsDir).toMatch(/\/models$/);
    const cfg = join(dir, 'config.yaml');
    writeFileSync(cfg, 'laya_models_dir: /somewhere/laya\n');
    expect(loadLibraryConfig(cfg).layaModelsDir).toBe('/somewhere/laya');
  });
});

describe('model ids', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lt-laya-id-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const installed = (name: string, source: string | null, revision: string | null): InstalledModel => ({
    name,
    dir,
    visionDir: dir,
    source,
    revision,
    jobId: null,
  });

  it('names a model from Hugging Face by its id and revision', async () => {
    expect(await installedModelId(installed('laya-base', 'thaitea/laya-vision', 'abc'))).toBe('thaitea/laya-vision@abc');
  });

  it('names a model from a folder by its name and decoder’s SHA-256, kept beside it until the file changes', async () => {
    writeFileSync(join(dir, 'decoder.onnx'), 'one');
    const m = installed('laya-new', '/x/best', null);
    const first = await installedModelId(m);
    expect(first).toBe(`laya-new@sha256:${createHash('sha256').update('one').digest('hex')}`);
    expect(existsSync(join(dir, 'decoder.onnx.sha256.json'))).toBe(true);
    expect(await installedModelId(m)).toBe(first);
    expect(await layaNewModelId(dir)).toBe(first);
    writeFileSync(join(dir, 'decoder.onnx'), 'two, longer');
    expect(await installedModelId(m)).not.toBe(first);
    expect(await installedModelId(installed('laya-run-best', '/x/best', null))).toMatch(/^laya-run-best@sha256:/);
  });
});
