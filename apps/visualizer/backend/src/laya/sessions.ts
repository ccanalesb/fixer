/**
 * Laya base and Laya new as ONNX sessions. Runs inside the Laya worker thread (`worker.ts`):
 * `session.run` holds the thread for up to ~0.8 s per pass (ADR-0020).
 *
 * The image is encoded once; both decoders read the same features, since Laya new's vision tower is
 * Laya base's. One decoder pass per question, as the research runs answered them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PreTrainedTokenizer } from '@huggingface/transformers';
import * as ort from 'onnxruntime-node';
import { decodePlaneFromFile } from '../imaging/decode-plane.js';
import type { LayaModelFiles } from './files.js';
import { LAYA_PIXEL_VALUES_SHAPE, layaPixelValues } from './image.js';
import { LAYA_QUESTIONS, type LayaModelName } from './questions.js';
import {
  IMAGE_PREFIX_TEXT,
  buildRow,
  softmax,
  type LayaModelMeta,
  type LayaQuestion,
  type LayaRow,
} from './rows.js';

export { LAYA_QUESTIONS, type LayaModelName } from './questions.js';

/** Level probabilities per question id, lowest level first. */
export type LayaModelAnswers = Record<string, number[]>;

export interface LayaAnswers {
  base: LayaModelAnswers;
  /** Null when the Score forecast stage is off. */
  new: LayaModelAnswers | null;
}

export interface LayaSeconds {
  prep: number;
  vision: number;
  base: number;
  new: number;
  total: number;
}

interface Decoder {
  session: ort.InferenceSession;
  meta: LayaModelMeta;
  rows: LayaRow[];
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

/** What a worker is asked, per model; defaults to `questions.json`, the rows the setup step's reference checks. */
export type LayaQuestionsByModel = Record<LayaModelName, Record<string, LayaQuestion>>;

/** One photo's request: Laya base rows by question id (all when absent), and whether Laya new runs. */
export interface LayaAnswerWant {
  base?: readonly string[];
  new?: boolean;
}

export function buildModelRows(
  dir: string,
  name: LayaModelName,
  questions: Record<string, LayaQuestion> = LAYA_QUESTIONS[name],
): { meta: LayaModelMeta; rows: LayaRow[] } {
  const meta = readJson<LayaModelMeta>(join(dir, 'model.json'));
  const tok = loadTokenizer(dir);
  const encode = (s: string): number[] => tok.encode(s, { add_special_tokens: false });
  if (encode(IMAGE_PREFIX_TEXT).join(',') !== meta.prefix_ids.join(',')) {
    throw new Error(`Laya ${name}: the tokenizer's image prefix differs from model.json`);
  }
  const rows = Object.entries(questions).map(([qid, q]) => buildRow(encode, meta, qid, q));
  return { meta, rows };
}

export async function loadLayaPixelValues(file: string): Promise<Float32Array> {
  return layaPixelValues(await decodePlaneFromFile(file, { colourspace: 'srgb', removeAlpha: true }));
}

export class LayaSessions {
  private constructor(
    private readonly vision: ort.InferenceSession,
    private readonly decoders: { base: Decoder; new: Decoder | null },
  ) {}

  static async load(files: LayaModelFiles, questions: LayaQuestionsByModel = LAYA_QUESTIONS): Promise<LayaSessions> {
    const vision = await ort.InferenceSession.create(join(files.baseDir, 'vision.onnx'), SESSION_OPTIONS);
    const decoder = async (dir: string, name: LayaModelName): Promise<Decoder> => ({
      ...buildModelRows(dir, name, questions[name]),
      session: await ort.InferenceSession.create(join(dir, 'decoder.onnx'), SESSION_OPTIONS),
    });
    return new LayaSessions(vision, {
      base: await decoder(files.baseDir, 'base'),
      new: files.newDir ? await decoder(files.newDir, 'new') : null,
    });
  }

  get scoreForecastOn(): boolean {
    return this.decoders.new !== null;
  }

  /** Answers what `want` asks for (everything by default); the image is encoded once either way. */
  async answerFile(file: string, want: LayaAnswerWant = {}): Promise<{ answers: LayaAnswers; seconds: LayaSeconds }> {
    const t = [performance.now()];
    const pv = await loadLayaPixelValues(file);
    t.push(performance.now());
    const out = await this.vision.run({
      pixel_values: new ort.Tensor('float32', pv, [...LAYA_PIXEL_VALUES_SHAPE]),
    });
    const feats = out.image_features!;
    t.push(performance.now());
    const base = await this.answerAll(this.decoders.base, feats, want.base);
    t.push(performance.now());
    const neu = this.decoders.new && want.new !== false ? await this.answerAll(this.decoders.new, feats) : null;
    t.push(performance.now());
    const s = (i: number) => (t[i + 1]! - t[i]!) / 1000;
    return {
      answers: { base, new: neu },
      seconds: { prep: s(0), vision: s(1), base: s(2), new: s(3), total: (t[4]! - t[0]!) / 1000 },
    };
  }

  private async answerAll(d: Decoder, feats: ort.Tensor, only?: readonly string[]): Promise<LayaModelAnswers> {
    const out: LayaModelAnswers = {};
    const wanted = only ? new Set(only) : null;
    for (const row of d.rows) {
      if (!wanted || wanted.has(row.qid)) out[row.qid] = await this.answerRow(d, row, feats);
    }
    return out;
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
