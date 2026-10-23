/**
 * A model's token rows, built as the model was trained (prompt format "1", terminator readout) for an
 * image-only state: with no state text, a row depends on the question alone, so each model's rows are
 * built once at load.
 *
 * Must stay token-for-token equal to the converter's; `reference/rows.json` from the setup step is the check.
 */

import type { QuestionType, SystemOneQuestion } from '../systemone/question.js';

/** `model.json` written by `scripts/app-models/export_onnx.py`. */
export interface ModelMeta {
  temperature: number[];
  temperature_by_options: Record<string, number>;
  max_len: number;
  head_max_len: number;
  image_token_id: number;
  pad_token_id: number;
  prefix_ids: number[];
}

export interface ModelRow {
  qid: string;
  ids: number[];
  markers: number[];
  optionSpan: [number, number];
  qtype: number;
  /** Number of options; the decoder's logits past it are padding. */
  k: number;
  temperature: number;
}

export type Encode = (text: string) => number[];

const OPTION_BULLET = '- ';
const OPTION_END = '\n';
const OPTION_MAX_TOKENS = 48;
const QTYPES: Record<QuestionType, number> = { choice: 0, score: 1, noul: 2 };
const QTYPE_NAMES: readonly QuestionType[] = ['choice', 'score', 'noul'];

export const IMAGE_SEQ_LEN = 64;
/** One 512×512 tile, no splitting: the text the processor expands the image into. */
export const IMAGE_PREFIX_TEXT =
  '<|im_start|>User:<fake_token_around_image><global-img>' +
  '<image>'.repeat(IMAGE_SEQ_LEN) +
  '<fake_token_around_image>';

export function qtypeName(qtype: number): QuestionType {
  return QTYPE_NAMES[qtype]!;
}

function questionText(type: QuestionType, instructions: string): string {
  return `\n${type} question: ${instructions}<end_of_utterance>\nAssistant: Options:\n`;
}

export function renderOptions(q: SystemOneQuestion): string[] {
  if (q.type === 'choice') {
    const crit = Array.isArray(q.criteria)
      ? Object.fromEntries(q.criteria.map((c) => [c, null]))
      : (q.criteria ?? {});
    return Object.entries(crit).map(([k, v]) => (v ? `${k}: ${v}` : k));
  }
  if (q.type === 'score') return (q.criteria as string[]).map((c, i) => `level ${i}: ${c}`);
  const crit = (q.criteria ?? {}) as Record<string, string | null>;
  return [
    'false: ' + (crit.false || 'no, the statement does not hold'),
    'true: ' + (crit.true || 'yes, the statement holds'),
  ];
}

/** The key of a per-option-count temperature in `model.json`. */
export function tempBucket(qtype: number, k: number): string {
  const size = k <= 2 ? '2' : k <= 5 ? '3-5' : k <= 10 ? '6-10' : '11+';
  return `${qtypeName(qtype)}:${size}`;
}

/** Options capped at 48 tokens each; past the head budget, options shrink first, then the question is cut in the middle. */
export function buildRow(encode: Encode, meta: ModelMeta, qid: string, q: SystemOneQuestion): ModelRow {
  const endIds = encode(OPTION_END);
  if (endIds.length !== 1) throw new Error('option terminator must be a single token');
  const endId = endIds[0]!;
  const opts = renderOptions(q);
  let optIds = opts.map((o) => encode(OPTION_BULLET + o.replaceAll(OPTION_END, ' ')).slice(0, OPTION_MAX_TOKENS));
  const headMax = meta.head_max_len;
  let headIds = encode(questionText(q.type, q.instructions.replaceAll('<end_of_utterance>', ' ')));
  const sumOpts = () => optIds.reduce((s, o) => s + o.length + 1, 0);
  let optBudget = headMax - sumOpts();
  if (optBudget < 16) {
    const per = Math.max(4, Math.floor((headMax - 16) / Math.max(1, optIds.length)) - 1);
    optIds = optIds.map((o) => o.slice(0, per));
    optBudget = headMax - sumOpts();
  }
  if (headIds.length > Math.max(8, optBudget)) {
    const keep = Math.max(8, optBudget);
    const half = Math.floor(keep / 2);
    headIds = [...headIds.slice(0, half), ...headIds.slice(headIds.length - (keep - half))];
  }
  const tail = [...headIds];
  const markers: number[] = [];
  const spanStart = tail.length;
  for (const o of optIds) {
    tail.push(...o, endId);
    markers.push(tail.length - 1);
  }
  const off = meta.prefix_ids.length;
  if (off + tail.length > meta.max_len) throw new Error(`question ${qid} and the image exceed max_len`);
  const qtype = QTYPES[q.type];
  const k = opts.length;
  return {
    qid,
    ids: [...meta.prefix_ids, ...tail],
    markers: markers.map((m) => m + off),
    optionSpan: [spanStart + off, tail.length + off],
    qtype,
    k,
    temperature: meta.temperature_by_options[tempBucket(qtype, k)] ?? meta.temperature[qtype]!,
  };
}

export function softmax(z: readonly number[]): number[] {
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}
