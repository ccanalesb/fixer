/**
 * Adding a model to this app: what the source is, what the model is called, and the conversion job
 * (`app_model_install`) that runs `scripts/app-models/export_onnx.py` through `uv`.
 *
 * A model being converted is its job; an installed one is its directory (`files.ts`). The script writes
 * under a dot directory and renames it when every check has passed, so a failed or cancelled conversion
 * leaves nothing that lists.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { expandUserPath } from '../config.js';
import type { Db } from '../db/connection.js';
import { createJob, getActiveJobs, type JobRow } from '../db/jobs/jobs.js';
import { installedModels } from './files.js';

export const APP_MODEL_INSTALL_JOB_TYPE = 'app_model_install';

/** A source that is neither a folder nor a Hugging Face id, or one already converting (HTTP 400 / 409). */
export class AppModelSourceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 400,
  ) {
    super(message);
  }
}

export type ModelSource =
  | { kind: 'folder'; /** Absolute, `~` expanded. */ source: string }
  | { kind: 'hugging_face'; /** `id` or `id@revision`, as entered. */ source: string };

const HUGGING_FACE_ID = /^[A-Za-z0-9][\w.-]*\/[\w.-]+(@[\w./-]+)?$/;
/** Checkpoint folder names that say nothing about the model: the parent's name goes before them. */
const GENERIC_FOLDER = /^(best|last|latest|final|model|checkpoint([-_]\d+)?)$/i;

/** Finder's "Copy as Pathname" wraps paths with spaces in single quotes. */
function unquote(raw: string): string {
  const t = raw.trim();
  const q = t[0];
  return t.length >= 2 && (q === "'" || q === '"') && t[t.length - 1] === q ? t.slice(1, -1).trim() : t;
}

export function parseModelSource(raw: string): ModelSource {
  const text = unquote(raw);
  if (/^[/~.]/.test(text)) {
    const path = resolve(expandUserPath(text));
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new AppModelSourceError(`No folder at ${path}`);
    return { kind: 'folder', source: path };
  }
  if (HUGGING_FACE_ID.test(text)) return { kind: 'hugging_face', source: text };
  throw new AppModelSourceError(
    'Enter a folder in Hugging Face format or a Hugging Face id (owner/name, or owner/name@revision)',
  );
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|-+$/g, '') || 'model';
}

/** What the source would be called, made unique against `taken`. */
export function modelNameFor(src: ModelSource, taken: ReadonlySet<string>): string {
  let name: string;
  if (src.kind === 'hugging_face') {
    const repo = src.source.split('@')[0]!;
    name = slug(repo.split('/')[1]!);
  } else {
    const leaf = basename(src.source);
    name = slug(GENERIC_FOLDER.test(leaf) ? `${basename(dirname(src.source))}-${leaf}` : leaf);
  }
  if (!taken.has(name)) return name;
  let i = 2;
  while (taken.has(`${name}-${i}`)) i += 1;
  return `${name}-${i}`;
}

export interface AppModelStatus {
  name: string;
  source: string | null;
  revision: string | null;
  status: 'ready' | 'converting';
  job_id: string | null;
}

export interface InstallJobMetadata {
  source: string;
  name: string;
}

function installJobs(activeJobs: readonly JobRow[]): (JobRow & { metadata: Partial<InstallJobMetadata> })[] {
  return activeJobs
    .filter((j) => j.type === APP_MODEL_INSTALL_JOB_TYPE)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** The models a conversion job is still installing, from the jobs pending or running. */
export function convertingModelNames(activeJobs: readonly JobRow[]): Set<string> {
  return new Set(installJobs(activeJobs).flatMap((j) => (j.metadata.name ? [j.metadata.name] : [])));
}

/** Installed models, then the ones still converting, in the order they were added. */
export function listAppModels(modelsDir: string, jobsDb: Db): AppModelStatus[] {
  const ready: AppModelStatus[] = installedModels(modelsDir).map((m) => ({
    name: m.name,
    source: m.source,
    revision: m.revision,
    status: 'ready',
    job_id: m.jobId,
  }));
  const readyNames = new Set(ready.map((m) => m.name));
  const converting: AppModelStatus[] = installJobs(getActiveJobs(jobsDb))
    .filter((j) => j.metadata.name && !readyNames.has(j.metadata.name))
    .map((j) => ({
      name: j.metadata.name!,
      source: j.metadata.source ?? null,
      revision: null,
      status: 'converting',
      job_id: j.id,
    }));
  return [...ready, ...converting];
}

/** Queues the conversion; the model lists as converting until the job has installed it. */
export function addAppModel(jobsDb: Db, modelsDir: string, raw: string): { name: string; job_id: string } {
  const src = parseModelSource(raw);
  const active = installJobs(getActiveJobs(jobsDb));
  const same = active.find((j) => j.metadata.source === src.source);
  if (same) throw new AppModelSourceError(`Already converting as ${same.metadata.name}`, 409);
  const taken = new Set<string>(active.map((j) => j.metadata.name).filter((n): n is string => Boolean(n)));
  if (existsSync(modelsDir)) for (const d of readdirSync(modelsDir)) taken.add(d.replace(/^\.install-/, ''));
  const name = modelNameFor(src, taken);
  const metadata: InstallJobMetadata = { source: src.source, name };
  return { name, job_id: createJob(jobsDb, APP_MODEL_INSTALL_JOB_TYPE, metadata) };
}
