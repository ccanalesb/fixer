/**
 * Stable ids for System One providers created from a culling stage URL.
 * Two stages with the same URL and key share one id; the same URL with different keys get distinct ids.
 */
export function normalizeCullingEndpointUrl(raw: string): string {
  const text = raw.trim().replace(/\/+$/, '');
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return text;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return text;
  }
}

/** Id derived from the URL host (and port when not default). */
export function providerIdFromCullingUrl(url: string): string {
  const u = new URL(normalizeCullingEndpointUrl(url));
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  const defaultPort = u.protocol === 'https:' ? '443' : '80';
  const host = port === defaultPort ? u.hostname : `${u.hostname}-${port}`;
  return host.replace(/\./g, '-').toLowerCase();
}

export function cullingProviderDedupKey(url: string, apiKey: string): string {
  return `${normalizeCullingEndpointUrl(url)}\0${apiKey}`;
}

export function isExternalCullingEndpoint(endpoint: string): boolean {
  const text = endpoint.trim();
  if (!text || text === 'this_app') return false;
  try {
    const u = new URL(text);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
