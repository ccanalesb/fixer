/**
 * The installed models as ONNX sessions, each loaded on its first question. Runs inside the model worker
 * thread (`worker.ts`): `session.run` holds the thread for up to ~0.8 s per pass (ADR-0020).
 *
 * Models with the same vision tower read one vision graph (a fine-tune reads the one of the model it
 * came from); the last image's features are kept per graph, so asking a second model about the same photo
 * does not encode it again. One decoder pass per question.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PreTrainedTokenizer } from '@huggingface/transformers';
import * as ort from 'onnxruntime-node';
import { decodePlaneFromFile } from '../imaging/decode-plane.js';
import { canonicalJson } from '../utils/canonical-json.js';
import type { InstalledModel } from './files.js';
import { PIXEL_VALUES_SHAPE, imagePixelValues } from './image.js';
import {
  IMAGE_PREFIX_TEXT,
  buildRow,
  softmax,
  type Encode,
  type ModelMeta,
  type ModelRow,
} from './rows.js';
import type { SystemOneQuestion } from '../systemone/question.js';

/** Level probabilities per question id, lowest level first. */
export type ModelAnswers = Record<string, number[]>;

export interface AnswerSeconds {
  prep: number;
  vision: number;
  decoder: number;
  total: number;
}

export interface ImageAnswer {
  answers: ModelAnswers;
  seconds: AnswerSeconds;
  /** Tokens in the rows asked, image included: the System One `usage`. */
  inputTokens: number;
}

interface Decoder {
  session: ort.InferenceSession;
  meta: ModelMeta;
  encode: Encode;
  /** Rows by question text: a row depends on the question alone (image-only state). */
  rows: Map<string, ModelRow>;
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

function loadMetaAndEncode(dir: string): { meta: ModelMeta; encode: Encode } {
  const meta = readJson<ModelMeta>(join(dir, 'model.json'));
  const tok = loadTokenizer(dir);
  const encode = (s: string): number[] => tok.encode(s, { add_special_tokens: false });
  if (encode(IMAGE_PREFIX_TEXT).join(',') !== meta.prefix_ids.join(',')) {
    throw new Error(`${dir}: the tokenizer's image prefix differs from model.json`);
  }
  return { meta, encode };
}

/** The rows the setup step's reference checks. */
export function buildModelRows(
  dir: string,
  questions: Record<string, SystemOneQuestion>,
): { meta: ModelMeta; rows: ModelRow[] } {
  const { meta, encode } = loadMetaAndEncode(dir);
  return { meta, rows: Object.entries(questions).map(([qid, q]) => buildRow(encode, meta, qid, q)) };
}

export async function loadPixelValues(file: string | Uint8Array): Promise<Float32Array> {
  const input = typeof file === 'string' ? file : Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  return imagePixelValues(await decodePlaneFromFile(input, { colourspace: 'srgb', removeAlpha: true }));
}

interface Vision {
  session: ort.InferenceSession;
  lastImage: { hash: string; features: ort.Tensor } | null;
}

/** Where one model's files are: what the worker needs of an installed model. */
export type ModelRef = Pick<InstalledModel, 'name' | 'dir' | 'visionDir'>;

export class ModelSessions {
  /** By directory: a model is loaded once, whatever it is called. */
  private readonly decoders = new Map<string, Promise<Decoder>>();
  private readonly visions = new Map<string, Promise<Vision>>();

  private decoder(dir: string): Promise<Decoder> {
    let d = this.decoders.get(dir);
    if (!d) {
      d = (async () => ({
        ...loadMetaAndEncode(dir),
        rows: new Map(),
        session: await ort.InferenceSession.create(join(dir, 'decoder.onnx'), SESSION_OPTIONS),
      }))();
      this.decoders.set(dir, d);
      d.catch(() => this.decoders.delete(dir));
    }
    return d;
  }

  private vision(dir: string): Promise<Vision> {
    let v = this.visions.get(dir);
    if (!v) {
      v = (async () => ({
        session: await ort.InferenceSession.create(join(dir, 'vision.onnx'), SESSION_OPTIONS),
        lastImage: null,
      }))();
      this.visions.set(dir, v);
      v.catch(() => this.visions.delete(dir));
    }
    return v;
  }

  /** Every question about one image, asked of one model. */
  async answerImage(model: ModelRef, image: Uint8Array, questions: Record<string, SystemOneQuestion>): Promise<ImageAnswer> {
    let d: Decoder;
    let vision: Vision;
    try {
      [d, vision] = await Promise.all([this.decoder(model.dir), this.vision(model.visionDir)]);
    } catch (e) {
      throw new Error(`${model.name} failed to load (${e instanceof Error ? e.message : String(e)})`);
    }
    const rows = Object.entries(questions).map(([qid, q]) => this.row(d, qid, q));
    const t0 = performance.now();
    const hash = createHash('sha256').update(image).digest('hex');
    let prep = 0;
    if (vision.lastImage?.hash !== hash) {
      const pv = await loadPixelValues(image);
      prep = (performance.now() - t0) / 1000;
      const out = await vision.session.run({ pixel_values: new ort.Tensor('float32', pv, [...PIXEL_VALUES_SHAPE]) });
      vision.lastImage = { hash, features: out.image_features! };
    }
    const features = vision.lastImage.features;
    const t1 = performance.now();
    const answers: ModelAnswers = {};
    for (const r of rows) answers[r.qid] = await this.answerRow(d, r, features);
    const t2 = performance.now();
    return {
      answers,
      seconds: { prep, vision: (t1 - t0) / 1000 - prep, decoder: (t2 - t1) / 1000, total: (t2 - t0) / 1000 },
      inputTokens: rows.reduce((s, r) => s + r.ids.length, 0),
    };
  }

  private row(d: Decoder, qid: string, q: SystemOneQuestion): ModelRow {
    const key = canonicalJson(q);
    let row = d.rows.get(key);
    if (!row) {
      row = buildRow(d.encode, d.meta, qid, q);
      d.rows.set(key, row);
    }
    return { ...row, qid };
  }

  private async answerRow(d: Decoder, r: ModelRow, feats: ort.Tensor): Promise<number[]> {
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
    const loaded = await Promise.allSettled([...this.visions.values(), ...this.decoders.values()]);
    for (const r of loaded) if (r.status === 'fulfilled') await r.value.session.release();
  }
}
