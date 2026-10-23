/**
 * The models installed in this app: one directory per model in `app_models_dir`, written by
 * `scripts/app-models/export_onnx.py` (through the conversion job or by hand), and the error that names what
 * is missing.
 *
 * `models/` is git-ignored: the repo is public and no model is committed, so on a fresh checkout this
 * app lists nothing.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const APP_MODEL_SETUP_COMMAND = 'uv run scripts/app-models/export_onnx.py <folder or Hugging Face id> --name <name>';

/** A model this app does not have, or has with files missing; the message says what and how to add it. */
export class AppModelSetupError extends Error {
  override readonly name = 'AppModelSetupError';
}

export interface InstalledModel {
  name: string;
  /** Decoder, `model.json`, tokenizer, reference. */
  dir: string;
  /** The directory whose `vision.onnx` this model reads: its own, or an installed model's with the same vision tower. */
  visionDir: string;
  /** The Hugging Face id or folder it was converted from. */
  source: string | null;
  /** The Hugging Face commit; null for a folder. */
  revision: string | null;
  /** The conversion job that installed it; null when it was converted by hand. */
  jobId: string | null;
}

const MODEL_FILES = ['decoder.onnx', 'model.json', 'tokenizer/tokenizer.json', 'tokenizer/tokenizer_config.json'] as const;

/** An install in progress is written under a dot directory and renamed when it is complete. */
const isInstallInProgress = (name: string) => name.startsWith('.');

export function setupErrorMessage(problem: string): string {
  return `${problem}. Add it in Processing → Settings → Culling models, or from the repo root: ${APP_MODEL_SETUP_COMMAND}`;
}

interface ModelJson {
  source?: string | null;
  revision?: string | null;
  vision?: string;
  fine_tuned_from?: { id?: string; revision?: string } | null;
  job_id?: string | null;
}

function readModelJson(dir: string): ModelJson | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'model.json'), 'utf8')) as ModelJson;
  } catch {
    return null;
  }
}

/** The installed model a fine-tune came from, by its source and revision: it has the same vision tower. */
function fineTunedFromName(modelsDir: string, from: ModelJson['fine_tuned_from']): string | null {
  if (!from?.id) return null;
  for (const e of readdirSync(modelsDir, { withFileTypes: true })) {
    if (!e.isDirectory() || isInstallInProgress(e.name)) continue;
    const meta = readModelJson(join(modelsDir, e.name));
    if (meta?.source === from.id && (meta.revision ?? null) === (from.revision ?? null)) return e.name;
  }
  return null;
}

/** The model and the files it is missing, if any. */
function readModel(modelsDir: string, name: string): { model: InstalledModel; missing: string[] } {
  const dir = join(modelsDir, name);
  const missing = MODEL_FILES.map((f) => join(dir, f)).filter((p) => !existsSync(p));
  let meta: ModelJson = {};
  if (!missing.includes(join(dir, 'model.json'))) {
    const read = readModelJson(dir);
    if (read) meta = read;
    else missing.push(`${join(dir, 'model.json')} (unreadable)`);
  }
  const own = existsSync(join(dir, 'vision.onnx')) ? name : null;
  const visionDir = join(modelsDir, meta.vision ?? own ?? fineTunedFromName(modelsDir, meta.fine_tuned_from) ?? name);
  if (!existsSync(join(visionDir, 'vision.onnx'))) missing.push(join(visionDir, 'vision.onnx'));
  return {
    model: {
      name,
      dir,
      visionDir,
      source: meta.source ?? null,
      revision: meta.revision ?? null,
      jobId: meta.job_id ?? null,
    },
    missing,
  };
}

/** Every complete model, by name. Installs in progress and directories with files missing are left out. */
export function installedModels(modelsDir: string): InstalledModel[] {
  if (!existsSync(modelsDir)) return [];
  return readdirSync(modelsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !isInstallInProgress(e.name))
    .map((e) => readModel(modelsDir, e.name))
    .filter((r) => r.missing.length === 0)
    .map((r) => r.model)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveInstalledModel(modelsDir: string, name: string): InstalledModel {
  if (isInstallInProgress(name) || name.includes('/') || !existsSync(join(modelsDir, name))) {
    throw new AppModelSetupError(setupErrorMessage(`${name} is not listed by this app`));
  }
  const { model, missing } = readModel(modelsDir, name);
  if (missing.length > 0) {
    throw new AppModelSetupError(
      setupErrorMessage(`${name} is not listed by this app: model files missing: ${missing.join(', ')}`),
    );
  }
  return model;
}

/** The setup step's earlier layout kept the reference photo and its pixel values with the vision graph only. */
export function referenceImageDir(model: InstalledModel): string {
  const own = join(model.dir, 'reference');
  return existsSync(join(own, 'photo.png')) ? own : join(model.visionDir, 'reference');
}
