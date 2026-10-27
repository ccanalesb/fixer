import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
  type ExecFileOptions,
  type SpawnOptions,
} from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataRoot, resourcesRoot } from '../config.js';

export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: (error: Error | null) => void,
) => void;

export type ProcessTreeKiller = (pid: number, signal: NodeJS.Signals) => void;

export function createProcessTreeKiller(
  platform: string = process.platform,
  exec: ExecFileFn = execFile,
): ProcessTreeKiller {
  if (platform === 'win32') {
    return (pid, signal) => {
      const args =
        signal === 'SIGKILL' ? ['/pid', String(pid), '/T', '/F'] : ['/pid', String(pid), '/T'];
      exec('taskkill', args, { windowsHide: true }, () => {});
    };
  }
  return (pid, signal) => {
    try {
      process.kill(-pid, signal);
    } catch {
      // Already gone.
    }
  };
}

export function conversionChildSpawnOptions() {
  return {
    cwd: conversionCwd(),
    env: conversionSpawnEnv(),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  };
}

export const CONVERTER_PREP_STEP = 'Preparing the converter (first time only)';

export const CONVERSION_OFFLINE_MESSAGE =
  'Converting a model needs an internet connection the first time.';

export function resolveUvExecutable(): string {
  const name = process.platform === 'win32' ? 'uv.exe' : 'uv';
  const bundled = join(resourcesRoot(), 'bin', name);
  if (existsSync(bundled)) return bundled;
  return name;
}

/** Spawns `uv` (or a test wrapper when `LT_UV_TEST_WRAPPER` points at a Node script). */
export function spawnUv(
  args: readonly string[],
  options: SpawnOptions,
): ChildProcessWithoutNullStreams {
  const wrapper = process.env.LT_UV_TEST_WRAPPER;
  if (wrapper) {
    return spawn(process.execPath, [wrapper, ...args], options) as ChildProcessWithoutNullStreams;
  }
  return spawn(resolveUvExecutable(), args, options) as ChildProcessWithoutNullStreams;
}

export function conversionCwd(): string {
  return resourcesRoot();
}

export function conversionSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  env.UV_CACHE_DIR = join(dataRoot(), 'uv-cache');
  env.UV_PYTHON_INSTALL_DIR = join(dataRoot(), 'python');
  if (process.platform === 'win32') {
    env.PYTHONUTF8 = '1';
    env.PYTHONIOENCODING = 'utf-8';
  }
  return env;
}

const OFFLINE_PATTERNS: RegExp[] = [
  /\bnetwork is unreachable\b/i,
  /\bno route to host\b/i,
  /\bconnection refused\b/i,
  /\bconnection reset\b/i,
  /\bconnection timed out\b/i,
  /\btemporary failure in name resolution\b/i,
  /\bname or service not known\b/i,
  /\bnodename nor servname provided\b/i,
  /\bcould not resolve host\b/i,
  /\bfailed to fetch\b/i,
  /\bfailed to download\b/i,
  /\brequest failed after\b/i,
  /\berror sending request\b/i,
  /client error\s*\(\s*connect\s*\)/i,
  /\bunable to download\b/i,
  /\bhttp error\b/i,
  /\b403 forbidden\b/i,
  /\b404 not found\b/i,
  /\bssl: certificate verify failed\b/i,
  /\boffline\b/i,
  /\bno internet\b/i,
];

/** True when uv or the script failed before conversion because dependencies could not be fetched. */
export function isConversionOfflineFailure(stderr: string, exitCode: number | null): boolean {
  if (exitCode === 0) return false;
  const text = stderr.trim();
  if (!text) return false;
  if (/^error: network:/m.test(text)) return true;
  return OFFLINE_PATTERNS.some((re) => re.test(text));
}

export function conversionFailureMessage(
  stderr: string,
  exitCode: number | null,
  scriptError: string | null,
  signal: NodeJS.Signals | null,
  stderrTail: string[],
): string {
  if (scriptError) return scriptError;
  if (isConversionOfflineFailure(stderr, exitCode)) return CONVERSION_OFFLINE_MESSAGE;
  const how = signal ? `stopped by ${signal}` : `exit code ${exitCode}`;
  return `The conversion failed (${how})${stderrTail.length ? `: ${stderrTail.join(' · ')}` : ''}`;
}
