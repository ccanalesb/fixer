/**
 * Laya base and Laya new as ONNX sessions. Runs inside the Laya worker thread (`worker.ts`):
 * `session.run` holds the thread for up to ~0.8 s per pass (ADR-0020).
 *
 * Both models read the same vision features, since Laya new's vision tower is Laya base's; the last
 * image's features are kept, so asking the second model about the same photo does not encode it
 * again. One decoder pass per question, as the research runs answered them.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PreTrainedTokenizer } from '@huggingface/transformers';
import * as ort from 'onnxruntime-node';
import { decodePlaneFromFile } from '../imaging/decode-plane.js';
import { canonicalJson } from '../utils/canonical-json.js';
import type { LayaModelFiles } from './files.js';
import { LAYA_PIXEL_VALUES_SHAPE, layaPixelValues } from './image.js';
import { LAYA_QUESTIONS, type LayaModelName } from './questions.js';
import {
  IMAGE_PREFIX_TEXT,
  buildRow,
  softmax,
  type Encode,
  type LayaModelMeta,
  type LayaQuestion,
  type LayaRow,
} from './rows.js';

/** Level probabilities per question id, lowest level first. */
export type LayaModelAnswers = Record<string, number[]>;

export interface LayaSeconds {
  prep: number;
  vision: number;
  decoder: number;
  total: number;
}

export interface LayaImageAnswer {
  answers: LayaModelAnswers;
  seconds: LayaSeconds;
  /** Tokens in the rows asked, image included: the System One `usage`. */
  inputTokens: number;
}

interface Decoder {
  session: ort.InferenceSession;
  meta: LayaModelMeta;
  encode: Encode;
  /** Rows by question text: a row depends on the question alone (image-only state). */
  rows: Map<string, LayaRow>;
}

const SESSION_OPTIONS: ort.InferenceSession.SessionOptions = {
  executionProviders: ['cpu'],
  graphOptimizationLevel: 'all',
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Built from the exported files directly: `AutoTokenizer` would need the process-wide transformers `env`. */
function loadTokenizer(dir: string): PreTrainedTokenizer {
  return new PreTrainedTokenizer(
    readJson(join(dir, 'tokenizer', 'tokenizer.json')),
    readJson(join(dir, 'tokenizer', 'tokenizer_config.json')),
  );
}

function loadMetaAndEncode(dir: string, name: LayaModelName): { meta: LayaModelMeta; encode: Encode } {
  const meta = readJson<LayaModelMeta>(join(dir, 'model.json'));
  const tok = loadTokenizer(dir);
  const encode = (s: string): number[] => tok.encode(s, { add_special_tokens: false });
  if (encode(IMAGE_PREFIX_TEXT).join(',') !== meta.prefix_ids.join(',')) {
    throw new Error(`Laya ${name}: the tokenizer's image prefix differs from model.json`);
  }
  return { meta, encode };
}

/** The rows the setup step's reference checks (`questions.json` by default). */
export function buildModelRows(
  dir: string,
  name: LayaModelName,
  questions: Record<string, LayaQuestion> = LAYA_QUESTIONS[name],
): { meta: LayaModelMeta; rows: LayaRow[] } {
  const { meta, encode } = loadMetaAndEncode(dir, name);
  return { meta, rows: Object.entries(questions).map(([qid, q]) => buildRow(encode, meta, qid, q)) };
}

export async function loadLayaPixelValues(file: string | Uint8Array): Promise<Float32Array> {
  const input = typeof file === 'string' ? file : Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  return layaPixelValues(await decodePlaneFromFile(input, { colourspace: 'srgb', removeAlpha: true }));
}

export class LayaSessions {
  private lastImage: { hash: string; features: ort.Tensor } | null = null;

  private constructor(
    private readonly vision: ort.InferenceSession,
    private readonly decoders: { base: Decoder; new: Decoder | null },
  ) {}

  static async load(files: LayaModelFiles): Promise<LayaSessions> {
    const vision = await ort.InferenceSession.create(join(files.baseDir, 'vision.onnx'), SESSION_OPTIONS);
    const decoder = async (dir: string, name: LayaModelName): Promise<Decoder> => ({
      ...loadMetaAndEncode(dir, name),
      rows: new Map(),
      session: await ort.InferenceSession.create(join(dir, 'decoder.onnx'), SESSION_OPTIONS),
    });
    return new LayaSessions(vision, {
      base: await decoder(files.baseDir, 'base'),
      new: files.newDir ? await decoder(files.newDir, 'new') : null,
    });
  }

  get models(): LayaModelName[] {
    return this.decoders.new ? ['base', 'new'] : ['base'];
  }

  /** Every question about one image, asked of one model. */
  async answerImage(name: LayaModelName, image: Uint8Array, questions: Record<string, LayaQuestion>): Promise<LayaImageAnswer> {
    const d = this.decoders[name];
    if (!d) throw new Error(`Laya ${name} is not loaded`);
    const rows = Object.entries(questions).map(([qid, q]) => this.row(d, qid, q));
    const t0 = performance.now();
    const hash = createHash('sha256').update(image).digest('hex');
    let prep = 0;
    if (this.lastImage?.hash !== hash) {
      const pv = await loadLayaPixelValues(image);
      prep = (performance.now() - t0) / 1000;
      const out = await this.vision.run({ pixel_values: new ort.Tensor('float32', pv, [...LAYA_PIXEL_VALUES_SHAPE]) });
      this.lastImage = { hash, features: out.image_features! };
    }
    const t1 = performance.now();
    const answers: LayaModelAnswers = {};
    for (const r of rows) answers[r.qid] = await this.answerRow(d, r, this.lastImage.features);
    const t2 = performance.now();
    return {
      answers,
      seconds: { prep, vision: (t1 - t0) / 1000 - prep, decoder: (t2 - t1) / 1000, total: (t2 - t0) / 1000 },
      inputTokens: rows.reduce((s, r) => s + r.ids.length, 0),
    };
  }

  private row(d: Decoder, qid: string, q: LayaQuestion): LayaRow {
    const key = canonicalJson(q);
    let row = d.rows.get(key);
    if (!row) {
      row = buildRow(d.encode, d.meta, qid, q);
      d.rows.set(key, row);
    }
    return { ...row, qid };
  }

  private async answerRow(d: Decoder, r: LayaRow, feats: ort.Tensor): Promise<number[]> {
    const L = r.ids.length;
    const K = r.markers.length;
    const out = await d.session.run({
      input_ids: new ort.Tensor('int64', BigInt64Array.from(r.ids, BigInt), [1, L]),
      attention_mask: new ort.Tensor('int64', new BigInt64Array(L).fill(1n), [1, L]),
      option_span: new ort.Tensor('int64', BigInt64Array.from(r.optionSpan, BigInt), [1, 2]),
      qtype: new ort.Tensor('int64', BigInt64Array.of(BigInt(r.qtype)), [1]),
      marker_pos: new ort.Tensor('int64', BigInt64Array.from(r.markers, BigInt), [1, K]),
      marker_mask: new ort.Tensor('bool', new Uint8Array(K).fill(1), [1, K]),
      image_features: feats,
    });
    const logits = out.logits!.data as Float32Array;
    const temp = Math.max(1e-3, r.temperature);
    return softmax(Array.from(logits.subarray(0, r.k), (v) => v / temp));
  }

  async release(): Promise<void> {
    await this.vision.release();
    await this.decoders.base.session.release();
    await this.decoders.new?.session.release();
  }
}
