/**
 * Installing a model into this app: the source and name rules, the list with its conversion jobs, and
 * the `laya_model_install` job. A fake `uv` on PATH stands in for the conversion script, so the real
 * child process, its output, cancellation and cleanup are exercised without converting anything.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../src/db/connection.js';
import { createJob, getJob, initJobsDb, updateJobStatus } from '../src/db/jobs/jobs.js';
import { JobRunner } from '../src/jobs/runner.js';
import { recoverOrphanedJobs, tick } from '../src/jobs/processor.js';
import { transitionCancel } from '../src/jobs/transitions.js';
import { stopRunningConversions } from '../src/jobs/handlers/laya-install.js';
import {
  LAYA_INSTALL_JOB_TYPE,
  AppModelSourceError,
  addAppModel,
  listAppModels,
  modelNameFor,
  parseModelSource,
} from '../src/laya/install.js';

const FAKE_UV = `#!/bin/sh
# uv run <script> <source> --name <name> --out <out> --job-id <id>
shift 2
src="$1"; shift
while [ $# -gt 0 ]; do
  case "$1" in --name) name="$2"; shift 2;; --out) out="$2"; shift 2;; --job-id) job="$2"; shift 2;; *) shift;; esac
done
partial="$out/.install-$name"
mkdir -p "$partial"
case "$src" in
  */not-laya)
    echo "step: looking up $src"
    echo "error: not_laya: $src is not a Laya-family model: it has no vlm_agent_config.json" >&2
    rm -rf "$partial"; exit 2;;
  */parity)
    echo "error: parity: decoder: the ONNX graph differs from PyTorch by 2.00e-02, above 0.001" >&2; exit 2;;
  */crash)
    echo "Traceback (most recent call last):" >&2; echo "RuntimeError: out of memory" >&2; exit 1;;
  */slow)
    trap 'rm -rf "$partial"; exit 143' TERM
    echo "step: exporting the decoder graph"
    touch "$out/.slow-started"
    while :; do sleep 0.05; done;;
esac
echo "step: loading the model"
mkdir -p "$partial/tokenizer"
for f in decoder.onnx vision.onnx tokenizer/tokenizer.json tokenizer/tokenizer_config.json; do echo x > "$partial/$f"; done
case "$src" in /*) rev=null;; *) rev='"abc1234"';; esac
printf '{"source":"%s","revision":%s,"vision":"%s","job_id":"%s"}' "$src" "$rev" "$name" "$job" > "$partial/model.json"
mv "$partial" "$out/$name"
echo "done: $name in $out"
`;

let dir: string;
let modelsDir: string;
let db: Db;
const originalPath = process.env.PATH;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-install-'));
  modelsDir = join(dir, 'models');
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'uv'), FAKE_UV);
  chmodSync(join(dir, 'bin', 'uv'), 0o755);
  process.env.PATH = `${join(dir, 'bin')}:${originalPath}`;
  writeFileSync(join(dir, 'config.yaml'), `laya_models_dir: ${modelsDir}\n`);
  process.env.LT_CONFIG_YAML = join(dir, 'config.yaml');
  db = initJobsDb(join(dir, 'visualizer.db'));
});

afterEach(() => {
  db.close();
  process.env.PATH = originalPath;
  delete process.env.LT_CONFIG_YAML;
  rmSync(dir, { recursive: true, force: true });
});

const folder = (rel: string) => {
  const p = join(dir, rel);
  mkdirSync(p, { recursive: true });
  return p;
};
const run = () => tick(db, new JobRunner(db));
const job = (id: string) => getJob(db, id)!;
const names = () => listAppModels(modelsDir, db).map((m) => [m.name, m.status]);

describe('the source', () => {
  it('is a folder when it is a path, and must be one', () => {
    const p = folder('laya-run/best');
    expect(parseModelSource(p)).toEqual({ kind: 'folder', source: p });
    expect(parseModelSource(`  '${p}'  `)).toEqual({ kind: 'folder', source: p });
    expect(parseModelSource('~/')).toEqual({ kind: 'folder', source: homedir() });
    expect(() => parseModelSource(join(dir, 'nowhere'))).toThrow(`No folder at ${join(dir, 'nowhere')}`);
    writeFileSync(join(dir, 'file'), '');
    expect(() => parseModelSource(join(dir, 'file'))).toThrow(AppModelSourceError);
  });

  it('is a Hugging Face id otherwise, with or without a revision', () => {
    expect(parseModelSource('thaitea/laya-vision')).toEqual({ kind: 'hugging_face', source: 'thaitea/laya-vision' });
    expect(parseModelSource('thaitea/laya-vision@8b318c9')).toEqual({
      kind: 'hugging_face',
      source: 'thaitea/laya-vision@8b318c9',
    });
    for (const bad of ['', 'laya', 'a/b/c', 'thaitea/laya vision', 'thaitea/laya-vision@']) {
      expect(() => parseModelSource(bad), bad).toThrow(AppModelSourceError);
    }
  });
});

describe('the name', () => {
  const name = (raw: string, taken: string[] = []) => modelNameFor(parseModelSource(raw), new Set(taken));

  it('is laya-base for Laya base, the repo name for another Hugging Face model', () => {
    expect(name('thaitea/laya-vision')).toBe('laya-base');
    expect(name('Thaitea/Laya-Vision@8b318c9')).toBe('laya-base');
    expect(name('someone/My_Model.v2@main')).toBe('my_model.v2');
  });

  it('is the folder’s name, with its parent’s before a generic one', () => {
    expect(name(folder('models/laya-vision'))).toBe('laya-vision');
    expect(name(folder('laya-run/best'))).toBe('laya-run-best');
    expect(name(folder('run 3/checkpoint-1200'))).toBe('run-3-checkpoint-1200');
    expect(name(folder('x/Final'))).toBe('x-final');
  });

  it('gets -2, -3… when the name is taken', () => {
    expect(name('thaitea/laya-vision', ['laya-base'])).toBe('laya-base-2');
    expect(name('thaitea/laya-vision', ['laya-base', 'laya-base-2'])).toBe('laya-base-3');
  });
});

describe('adding a model', () => {
  it('queues one conversion job and lists the model as converting until it is installed', async () => {
    const added = addAppModel(db, modelsDir, 'thaitea/laya-vision');
    expect(added.name).toBe('laya-base');
    expect(job(added.job_id)).toMatchObject({
      type: LAYA_INSTALL_JOB_TYPE,
      status: 'pending',
      metadata: { source: 'thaitea/laya-vision', name: 'laya-base' },
    });
    expect(listAppModels(modelsDir, db)).toEqual([
      { name: 'laya-base', source: 'thaitea/laya-vision', revision: null, status: 'converting', job_id: added.job_id },
    ]);

    await run();
    expect(job(added.job_id).status).toBe('completed');
    expect(listAppModels(modelsDir, db)).toEqual([
      { name: 'laya-base', source: 'thaitea/laya-vision', revision: 'abc1234', status: 'ready', job_id: added.job_id },
    ]);
  });

  it('refuses a source already converting, and gives the same source a new name once it is installed', async () => {
    const first = addAppModel(db, modelsDir, 'thaitea/laya-vision');
    expect(() => addAppModel(db, modelsDir, 'thaitea/laya-vision')).toThrow('Already converting as laya-base');
    await run();
    expect(job(first.job_id).status).toBe('completed');
    expect(addAppModel(db, modelsDir, 'thaitea/laya-vision').name).toBe('laya-base-2');
  });

  it('does not list a failed or cancelled conversion', () => {
    const a = addAppModel(db, modelsDir, 'someone/a');
    const b = addAppModel(db, modelsDir, 'someone/b');
    updateJobStatus(db, a.job_id, 'failed');
    updateJobStatus(db, b.job_id, 'cancelled');
    expect(names()).toEqual([]);
    expect(addAppModel(db, modelsDir, 'someone/a').name).toBe('a');
  });
});

describe('the conversion job', () => {
  it('runs the script through uv and shows its steps', async () => {
    const src = folder('laya-run/best');
    const { job_id } = addAppModel(db, modelsDir, src);
    await run();
    const j = getJob(db, job_id, { logsLimit: 50 })!;
    expect(j.status).toBe('completed');
    expect(j.result).toMatchObject({ name: 'laya-run-best', source: src, revision: null });
    const messages = j.logs.map((l) => l.message);
    expect(messages).toContain('loading the model');
    expect(messages).not.toContain('step: loading the model');
    expect(messages).not.toContain('');
    expect(names()).toEqual([['laya-run-best', 'ready']]);
  });

  it('a non-Laya folder fails with the cause, and nothing half-written is listed or left', async () => {
    const { job_id } = addAppModel(db, modelsDir, folder('downloads/not-laya'));
    await run();
    expect(job(job_id).status).toBe('failed');
    expect(job(job_id).error).toBe(`${join(dir, 'downloads/not-laya')} is not a Laya-family model: it has no vlm_agent_config.json`);
    expect(names()).toEqual([]);
    expect(readdirSync(modelsDir)).toEqual([]);
  });

  it('a parity check above tolerance and an unexpected crash say so', async () => {
    const parity = addAppModel(db, modelsDir, 'someone/parity');
    await run();
    expect(job(parity.job_id).error).toBe(
      'Parity check failed: decoder: the ONNX graph differs from PyTorch by 2.00e-02, above 0.001',
    );
    const crash = addAppModel(db, modelsDir, 'someone/crash');
    await run();
    expect(job(crash.job_id).error).toBe(
      'The conversion failed (exit code 1): Traceback (most recent call last): · RuntimeError: out of memory',
    );
    expect(readdirSync(modelsDir)).toEqual([]);
  });

  it('without uv, says that uv is missing', async () => {
    process.env.PATH = join(dir, 'empty');
    const { job_id } = addAppModel(db, modelsDir, 'someone/a');
    await run();
    expect(job(job_id).status).toBe('failed');
    expect(job(job_id).error).toMatch(/^uv is not installed/);
  });

  it('is cancellable: the conversion is stopped and its files removed', async () => {
    const { job_id } = addAppModel(db, modelsDir, 'someone/slow');
    const running = run();
    while (!existsSync(join(modelsDir, '.slow-started'))) await new Promise((r) => setTimeout(r, 20));
    expect(job(job_id).current_step).toBe('exporting the decoder graph');
    transitionCancel(db, job_id);
    await running;
    expect(job(job_id).status).toBe('cancelled');
    expect(existsSync(join(modelsDir, '.install-slow'))).toBe(false);
    expect(names()).toEqual([]);
  });

  it('a backend that exits stops its conversion, so a resumed job is the only one writing', async () => {
    addAppModel(db, modelsDir, 'someone/slow');
    const running = run();
    while (!existsSync(join(modelsDir, '.slow-started'))) await new Promise((r) => setTimeout(r, 20));
    stopRunningConversions();
    await running;
    expect(existsSync(join(modelsDir, '.install-slow'))).toBe(false);
  });

  it('resumes after a restart: re-queued, converted from the start', async () => {
    const { job_id } = addAppModel(db, modelsDir, 'someone/a');
    const runner = new JobRunner(db);
    runner.startJob(job_id, LAYA_INSTALL_JOB_TYPE);
    runner.persistCheckpoint(job_id, { step: 'converting' });
    mkdirSync(join(modelsDir, '.install-a'), { recursive: true });
    expect(recoverOrphanedJobs(db)).toEqual([job_id]);
    expect(names()).toEqual([['a', 'converting']]);
    await run();
    expect(job(job_id).status).toBe('completed');
    expect(names()).toEqual([['a', 'ready']]);
  });

  it('a restart after the files were moved into place completes without converting again', async () => {
    const { job_id } = addAppModel(db, modelsDir, 'someone/a');
    await run();
    updateJobStatus(db, job_id, 'pending');
    process.env.PATH = join(dir, 'empty');
    await run();
    expect(job(job_id).status).toBe('completed');
  });

  it('a job queued by hand with no source fails saying so', async () => {
    const id = createJob(db, LAYA_INSTALL_JOB_TYPE, {});
    await run();
    expect(job(id).error).toBe('laya_model_install needs metadata.source and metadata.name');
  });
});
