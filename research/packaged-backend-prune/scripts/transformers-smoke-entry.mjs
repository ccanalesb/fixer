/**
 * Run with cwd = packaged backend root so `@huggingface/transformers` and `dist/` share one module graph.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PreTrainedTokenizer } from '@huggingface/transformers';
import { encodePixels } from './dist/src/imaging/clip-embed.js';

const hfHome = mkdtempSync(join(tmpdir(), 'lt-hf-'));
process.env.HF_HOME = hfHome;
process.env.TRANSFORMERS_CACHE = hfHome;

try {
  const tokCache = mkdtempSync(join(tmpdir(), 'lt-tok-'));
  const base = 'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main';
  for (const file of ['tokenizer.json', 'tokenizer_config.json']) {
    const res = await fetch(`${base}/${file}`);
    if (!res.ok) throw new Error(`tokenizer download failed: ${file} ${res.status}`);
    writeFileSync(join(tokCache, file), Buffer.from(await res.arrayBuffer()));
  }
  const tok = new PreTrainedTokenizer(
    JSON.parse(readFileSync(join(tokCache, 'tokenizer.json'), 'utf8')),
    JSON.parse(readFileSync(join(tokCache, 'tokenizer_config.json'), 'utf8')),
  );
  const ids = tok.encode('a photo of a cat', { add_special_tokens: false });
  if (!ids.length) throw new Error('tokenizer returned empty ids');

  const rgb = {
    width: 224,
    height: 224,
    data: new Uint8Array(224 * 224 * 3).fill(128),
  };
  const vec = await encodePixels(rgb);
  if (vec.length !== 512) throw new Error(`expected 512-d CLIP vector, got ${vec.length}`);
  let normSq = 0;
  for (let i = 0; i < vec.length; i++) {
    if (!Number.isFinite(vec[i])) throw new Error(`CLIP vector non-finite at index ${i}`);
    normSq += vec[i] * vec[i];
  }
  if (Math.abs(normSq - 1) > 0.05) {
    throw new Error(`CLIP vector L2 norm squared expected ~1, got ${normSq}`);
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
  process.stdout.write(
    JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
  );
  process.exit(1);
}
