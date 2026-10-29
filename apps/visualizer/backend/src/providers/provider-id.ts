/** Derive a stable provider id from a display name at creation time. */
export function deriveProviderId(name: string, taken: ReadonlySet<string>): string {
  let base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'provider';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
