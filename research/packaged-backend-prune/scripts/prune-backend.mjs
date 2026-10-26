/**
 * Remove packaged-backend weight that is safe to drop for the current host OS/arch.
 * Intended to run after `npm ci --omit=dev` + `npm run build` on each release-matrix runner.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @returns {'darwin-arm64' | 'linux-x64' | 'win32-x64'} */
export function hostPackTarget() {
  const { platform, arch } = process;
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'win32' && arch === 'x64') return 'win32-x64';
  throw new Error(`Unsupported pack target: ${platform}/${arch}`);
}

/** Relative paths under `node_modules/onnxruntime-node/bin/napi-v6/` to keep. */
const ORT_KEEP_SUBPATH = {
  'darwin-arm64': 'darwin/arm64',
  'linux-x64': 'linux/x64',
  'win32-x64': 'win32/x64',
};

const TRANSFORMERS_WEB_DIST = [
  'transformers.js',
  'transformers.min.js',
  'transformers.web.js',
  'transformers.web.min.js',
  'ort-wasm-simd-threaded.jsep.mjs',
];

/**
 * @param {string} backendRoot - directory containing `node_modules/` and `dist/`
 * @param {{ target?: ReturnType<typeof hostPackTarget> }} [opts]
 * @returns {{ removedBytes: number; steps: { id: string; bytes: number }[] }}
 */
export function pruneBackendTree(backendRoot, opts = {}) {
  const target = opts.target ?? hostPackTarget();
  const nm = join(backendRoot, 'node_modules');
  if (!existsSync(nm)) {
    throw new Error(`node_modules not found under ${backendRoot}`);
  }

  let removedBytes = 0;
  /** @type {{ id: string; bytes: number }[]} */
  const steps = [];

  const removePath = (id, abs) => {
    if (!existsSync(abs)) {
      steps.push({ id, bytes: 0 });
      return;
    }
    const bytes = duBytes(abs);
    rmSync(abs, { recursive: true, force: true });
    removedBytes += bytes;
    steps.push({ id, bytes });
  };

  const ortRoot = join(nm, 'onnxruntime-node', 'bin', 'napi-v6');
  const keepSub = ORT_KEEP_SUBPATH[target];
  if (existsSync(ortRoot)) {
    let ortForeign = 0;
    for (const name of readdirSync(ortRoot)) {
      for (const arch of readdirSync(join(ortRoot, name))) {
        const rel = `${name}/${arch}`;
        if (rel === keepSub) continue;
        const p = join(ortRoot, name, arch);
        const bytes = duBytes(p);
        rmSync(p, { recursive: true, force: true });
        ortForeign += bytes;
      }
    }
    removedBytes += ortForeign;
    steps.push({ id: 'onnxruntime-node-foreign-binaries', bytes: ortForeign });
  }

  removePath('onnxruntime-web-package', join(nm, 'onnxruntime-web'));

  const tfDist = join(nm, '@huggingface', 'transformers', 'dist');
  let tfWeb = 0;
  for (const file of TRANSFORMERS_WEB_DIST) {
    const p = join(tfDist, file);
    if (!existsSync(p)) continue;
    const bytes = duBytes(p);
    rmSync(p, { force: true });
    tfWeb += bytes;
  }
  if (tfWeb > 0) {
    removedBytes += tfWeb;
    steps.push({ id: 'transformers-web-dist-artifacts', bytes: tfWeb });
  }

  return { removedBytes, steps, target };
}

function duBytes(p) {
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const ent of readdirSync(p, { withFileTypes: true })) {
    const child = join(p, ent.name);
    total += ent.isDirectory() ? duBytes(child) : statSync(child).size;
  }
  return total;
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) {
  const backendRoot = process.argv[2] ?? process.cwd();
  const result = pruneBackendTree(backendRoot);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
