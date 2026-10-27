/**
 * `app_model_install` — convert one model into this app: `scripts/app-models/export_onnx.py` through `uv`, as
 * a child process the job waits on (the event loop stays free, ADR-0018).
 *
 * Cancelling stops the process group and removes what it had written. A restart re-queues the job (it
 * keeps a checkpoint) and the conversion runs again from the start; what was downloaded stays in the
 * Hugging Face cache.
 *
 * The script runs in its own process group, so the backend's Ctrl-C does not reach it; the backend's exit
 * stops it instead, or a quick restart would have two scripts writing the same `.install-<name>/`.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { config, loadLibraryConfig, resourcesRoot } from '../../config.js';
import {
  CONVERTER_PREP_STEP,
  conversionCwd,
  conversionFailureMessage,
  conversionSpawnEnv,
  resolveUvExecutable,
} from '../../app-models/conversion-run.js';
import { AppModelSetupError, resolveInstalledModel } from '../../app-models/files.js';
import { APP_MODEL_INSTALL_JOB_TYPE } from '../../app-models/install.js';
import type { JobRunner } from '../runner.js';
import { asMetadata } from './common.js';

function exportOnnxScriptPath(): string {
  return join(resourcesRoot(), 'scripts', 'app-models', 'export_onnx.py');
}
const CANCEL_POLL_MS = 200;
const KILL_GRACE_MS = 10_000;
const STEP = /^step: (.+)$/;
/** The script's last word on a failure it recognises. */
const SCRIPT_ERROR = /^error: (source|network|unsupported_architecture|parity): (.+)$/;
const STEP_PROGRESS: [RegExp, number][] = [
  [/^looking up/, 5],
  [/^downloading/, 10],
  [/^loading/, 30],
  [/vision tower/, 35],
  [/vision graph/, 40],
  [/^exporting the decoder/, 60],
  [/^checking the decoder/, 85],
];

export const UV_MISSING_MESSAGE =
  "uv is not installed, or not on the backend's PATH: the conversion runs scripts/app-models/export_onnx.py " +
  'through uv (https://docs.astral.sh/uv/getting-started/installation/)';

type Outcome = { ok: true } | { cancelled: true } | { error: string };

/** Process-group ids of the conversions running now. */
const running = new Set<number>();

export function stopRunningConversions(): void {
  for (const pid of running) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
}

process.on('exit', stopRunningConversions);

function scriptFailure(kind: string, message: string): string {
  return kind === 'parity' ? `Parity check failed: ${message}` : message;
}

function convert(runner: JobRunner, jobId: string, source: string, name: string, modelsDir: string): Promise<Outcome> {
  return new Promise((settle) => {
    runner.setCurrentStep(jobId, CONVERTER_PREP_STEP);
    const script = exportOnnxScriptPath();
    const child = spawn(
      resolveUvExecutable(),
      ['run', script, source, '--name', name, '--out', modelsDir, '--job-id', jobId],
      {
        cwd: conversionCwd(),
        env: conversionSpawnEnv(),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    if (child.pid) running.add(child.pid);
    let done = false;
    let cancelled = false;
    let scriptError: string | null = null;
    const stderrTail: string[] = [];
    const stderrLines: string[] = [];
    const finish = (o: Outcome) => {
      if (done) return;
      done = true;
      if (child.pid) running.delete(child.pid);
      clearInterval(poll);
      settle(o);
    };
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // Already gone.
      }
    };

    // The runner logs a step itself, so a `step:` line is not logged again.
    createInterface({ input: child.stdout }).on('line', (line) => {
      const step = STEP.exec(line)?.[1];
      if (!step) {
        if (line.trim()) runner.log(jobId, 'info', line);
        return;
      }
      const pct = STEP_PROGRESS.find(([re]) => re.test(step))?.[1];
      if (pct === undefined) runner.setCurrentStep(jobId, step);
      else runner.updateProgress(jobId, pct, step);
    });
    createInterface({ input: child.stderr }).on('line', (line) => {
      if (!line.trim()) return;
      runner.log(jobId, 'info', line);
      const m = SCRIPT_ERROR.exec(line);
      if (m) scriptError = scriptFailure(m[1]!, m[2]!);
      const trimmed = line.trim();
      stderrTail.push(trimmed);
      if (stderrTail.length > 3) stderrTail.shift();
      stderrLines.push(trimmed);
    });

    const poll = setInterval(() => {
      if (cancelled || !runner.isCancelled(jobId)) return;
      cancelled = true;
      signalGroup('SIGTERM');
      setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS).unref();
    }, CANCEL_POLL_MS);

    child.on('error', (e: NodeJS.ErrnoException) => {
      finish({ error: e.code === 'ENOENT' ? UV_MISSING_MESSAGE : `Could not start uv: ${e.message}` });
    });
    child.on('close', (code, signal) => {
      if (cancelled) return finish({ cancelled: true });
      if (code === 0) return finish({ ok: true });
      finish({
        error: conversionFailureMessage(stderrLines.join('\n'), code, scriptError, signal, stderrTail),
      });
    });
  });
}

/** The job whose conversion wrote this directory, if one did. */
function installedByJob(dir: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(dir, 'model.json'), 'utf8')) as { job_id?: string | null }).job_id ?? null;
  } catch {
    return null;
  }
}

export async function handleAppModelInstall(runner: JobRunner, jobId: string, metadata: unknown): Promise<void> {
  const meta = asMetadata(metadata);
  const source = typeof meta.source === 'string' ? meta.source : null;
  const name = typeof meta.name === 'string' ? meta.name : null;
  if (!source || !name) {
    runner.failJob(jobId, `${APP_MODEL_INSTALL_JOB_TYPE} needs metadata.source and metadata.name`);
    return;
  }
  const modelsDir = loadLibraryConfig(config.LT_CONFIG_YAML).appModelsDir;
  const finalDir = join(modelsDir, name);

  // Re-queued after a restart that came once the files were in place: nothing left to convert.
  if (!(existsSync(finalDir) && installedByJob(finalDir) === jobId)) {
    runner.persistCheckpoint(jobId, { step: 'converting' });
    const outcome = await convert(runner, jobId, source, name, modelsDir);
    rmSync(join(modelsDir, `.install-${name}`), { recursive: true, force: true });
    if ('cancelled' in outcome) {
      runner.finalizeCancelled(jobId);
      return;
    }
    if ('error' in outcome) {
      runner.failJob(jobId, outcome.error);
      return;
    }
  }

  let model;
  try {
    model = resolveInstalledModel(modelsDir, name);
  } catch (e) {
    if (!(e instanceof AppModelSetupError)) throw e;
    runner.failJob(jobId, `The conversion finished, but ${e.message}`);
    return;
  }
  runner.clearCheckpoint(jobId);
  runner.completeJob(jobId, {
    name,
    source: model.source,
    revision: model.revision,
    vision: basename(model.visionDir),
  });
}
