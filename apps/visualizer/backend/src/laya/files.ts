/**
 * Where the setup step left Laya's files, and the error that names what is missing.
 *
 * `models/` is git-ignored: the repo is public and no model is committed, so on a fresh checkout every
 * cull starts here.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const LAYA_SETUP_COMMAND =
  'uv run scripts/laya/export_onnx.py --laya-new <Laya new checkpoint directory>';

/** The cull cannot run until the setup step is (re)run; the message says what is missing and how. */
export class LayaSetupError extends Error {
  override readonly name = 'LayaSetupError';
}

export interface LayaModelFiles {
  /** Vision encoder shared by both models, Laya base's decoder, the reference photo. */
  baseDir: string;
  /** Null when Laya new was not exported: the Score forecast stage is off. */
  newDir: string | null;
}

const BASE_FILES = [
  'vision.onnx',
  'decoder.onnx',
  'model.json',
  'tokenizer/tokenizer.json',
  'tokenizer/tokenizer_config.json',
  'reference/photo.png',
] as const;
const NEW_FILES = [
  'decoder.onnx',
  'model.json',
  'tokenizer/tokenizer.json',
  'tokenizer/tokenizer_config.json',
] as const;

function missing(dir: string, files: readonly string[]): string[] {
  return files.map((f) => join(dir, f)).filter((p) => !existsSync(p));
}

export function setupErrorMessage(problem: string): string {
  return `${problem}. Run the setup step from the repo root: ${LAYA_SETUP_COMMAND}`;
}

/** A Laya new directory with only some of its files is an error, not "Score forecast off". */
export function resolveLayaModelFiles(modelsDir: string): LayaModelFiles {
  const baseDir = join(modelsDir, 'laya-base');
  const newDir = join(modelsDir, 'laya-new');
  const gone = missing(baseDir, BASE_FILES);
  if (existsSync(newDir)) gone.push(...missing(newDir, NEW_FILES));
  if (gone.length > 0) {
    throw new LayaSetupError(setupErrorMessage(`Laya model files missing: ${gone.join(', ')}`));
  }
  return { baseDir, newDir: existsSync(newDir) ? newDir : null };
}

export function referencePhotoPath(files: LayaModelFiles): string {
  return join(files.baseDir, 'reference', 'photo.png');
}
