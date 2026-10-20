/**
 * Canonical JSON: sorted object keys, escaped non-ASCII.
 *
 * Checkpoint fingerprints and cull version hashes are taken over it, so the byte sequence must not
 * change: resumed checkpoints and stored hashes compare against it.
 */
export function canonicalJson(value: unknown): string {
  return escapeNonAscii(JSON.stringify(sortKeys(value)));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return out;
}

function escapeNonAscii(json: string): string {
  // Only string contents can hold non-ASCII, and `JSON.stringify` has already
  // escaped everything else, so a blind pass over the output is safe.
  return json.replace(/[\u0080-\uffff]/g, (c) =>
    `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
