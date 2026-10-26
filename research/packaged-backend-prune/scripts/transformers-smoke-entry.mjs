/**
 * Run with cwd = packaged backend root so `@huggingface/transformers` and `dist/` share one module graph.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PreTrainedTokenizer, env } from '@huggingface/transformers';
import { decodeRgb, encodePixels } from './dist/src/imaging/clip-embed.js';

env.backends.onnx.executionProviders = ['cpu'];

const hfHome = mkdtempSync(join(tmpdir(), 'lt-hf-'));
process.env.HF_HOME = hfHome;
process.env.TRANSFORMERS_CACHE = hfHome;
process.env.HF_HUB_DISABLE_XET = '1';

function fail(message) {
  process.stdout.write(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
}

try {
  const tokCache = mkdtempSync(join(tmpdir(), 'lt-tok-'));
  const base = 'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main';
  for (const file of ['tokenizer.json', 'tokenizer_config.json']) {
    const res = await fetch(`${base}/${file}`);
    if (!res.ok) fail(`tokenizer download failed: ${file} ${res.status}`);
    writeFileSync(join(tokCache, file), Buffer.from(await res.arrayBuffer()));
  }
  const tok = new PreTrainedTokenizer(
    JSON.parse(readFileSync(join(tokCache, 'tokenizer.json'), 'utf8')),
    JSON.parse(readFileSync(join(tokCache, 'tokenizer_config.json'), 'utf8')),
  );
  const ids = tok.encode('a photo of a cat', { add_special_tokens: false });
  if (!ids.length) fail('tokenizer returned empty ids');

  const sampleImage = join(process.cwd(), 'tests', 'fixtures', 'imaging', 'noise_160x107.png');
  const vec = await encodePixels(await decodeRgb(sampleImage));
  if (vec.length !== 512) fail(`expected 512-d CLIP vector, got ${vec.length}`);
  let normSq = 0;
  for (let i = 0; i < vec.length; i++) {
    if (!Number.isFinite(vec[i])) fail(`CLIP vector non-finite at index ${i}`);
    normSq += vec[i] * vec[i];
  }
  if (Math.abs(normSq - 1) > 0.05) {
    fail(`CLIP vector L2 norm squared expected ~1, got ${normSq}`);
  }

  rmSync(tokCache, { recursive: true, force: true });
  rmSync(hfHome, { recursive: true, force: true });
  process.stdout.write(
    JSON.stringify({
      ok: true,
      tokenizerIds: ids.length,
      clipDim: vec.length,
      clipSample: vec[0],
    }),
  );
} catch (e) {
  rmSync(hfHome, { recursive: true, force: true });
  fail(e instanceof Error ? e.message : String(e));
}
