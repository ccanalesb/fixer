import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { REPO_ROOT } from '../src/config.js';
import {
  CONVERSION_OFFLINE_MESSAGE,
  CONVERTER_PREP_STEP,
  conversionCwd,
  conversionFailureMessage,
  conversionSpawnEnv,
  isConversionOfflineFailure,
  resolveUvExecutable,
} from '../src/app-models/conversion-run.js';

let dir: string;
const originalDataDir = process.env.LT_DATA_DIR;
const originalResourcesDir = process.env.LT_RESOURCES_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-convert-run-'));
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.LT_DATA_DIR;
  else process.env.LT_DATA_DIR = originalDataDir;
  if (originalResourcesDir === undefined) delete process.env.LT_RESOURCES_DIR;
  else process.env.LT_RESOURCES_DIR = originalResourcesDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveUvExecutable', () => {
  it('uses the bundled binary under resources when it exists', () => {
    const resources = join(dir, 'resources');
    mkdirSync(join(resources, 'bin'), { recursive: true });
    const bundled = join(resources, 'bin', 'uv');
    writeFileSync(bundled, '');
    chmodSync(bundled, 0o755);
    process.env.LT_RESOURCES_DIR = resources;
    process.env.PATH = '';
    expect(resolveUvExecutable()).toBe(bundled);
  });

  it('falls back to uv on PATH when nothing is bundled', () => {
    delete process.env.LT_RESOURCES_DIR;
    expect(resolveUvExecutable()).toBe('uv');
  });
});

describe('conversion cwd and env', () => {
  it('runs from the resources root', () => {
    process.env.LT_RESOURCES_DIR = join(dir, 'bundle');
    expect(conversionCwd()).toBe(join(dir, 'bundle'));
    delete process.env.LT_RESOURCES_DIR;
    expect(conversionCwd()).toBe(REPO_ROOT);
  });

  it('points uv cache and managed Python into the data folder', () => {
    process.env.LT_DATA_DIR = join(dir, 'data');
    const env = conversionSpawnEnv({});
    expect(env.UV_CACHE_DIR).toBe(join(dir, 'data', 'uv-cache'));
    expect(env.UV_PYTHON_INSTALL_DIR).toBe(join(dir, 'data', 'python'));
  });

  it('sets UTF-8 Python IO on Windows', () => {
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const env = conversionSpawnEnv({});
      expect(env.PYTHONUTF8).toBe('1');
      expect(env.PYTHONIOENCODING).toBe('utf-8');
    } finally {
      Object.defineProperty(process, 'platform', { value: platform });
    }
  });
});

describe('isConversionOfflineFailure', () => {
  const samples: [string, boolean][] = [
    ['error: Failed to download distribution `torch==2.14.0`', true],
    ['  Caused by: failed to fetch https://download.pytorch.org/whl/cpu/torch/', true],
    ['error: Request failed after 3 retries', true],
    ['  Caused by: error sending request for url (https://pypi.org/simple/numpy/)', true],
    ['  Caused by: client error (Connect)', true],
    ['  Caused by: dns error: failed to lookup address information: nodename nor servname provided, or not known', true],
    ['error: network: huggingface.co timed out', true],
    ['RuntimeError: out of memory', false],
    ['error: parity: decoder logits differ', false],
    ['error: unsupported_architecture: not SmolVLM', false],
  ];

  it.each(samples)('classifies %s as offline=%s', (line, offline) => {
    expect(isConversionOfflineFailure(line, 1)).toBe(offline);
  });

  it('maps offline stderr to the user-facing message', () => {
    const stderr = 'error: Failed to download distribution `onnxruntime==1.31.0`\n  Caused by: HTTP status client error (403 Forbidden)';
    expect(conversionFailureMessage(stderr, 1, null, null, [])).toBe(CONVERSION_OFFLINE_MESSAGE);
  });
});

describe('labels', () => {
  it('names the first job step', () => {
    expect(CONVERTER_PREP_STEP).toBe('Preparing the converter (first time only)');
  });
});
