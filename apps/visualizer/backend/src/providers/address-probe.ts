import { requestJson, type HttpEndpoint } from './http.js';
import { normalizeBaseUrlInput } from './base-url.js';

export interface AddressProbeResult {
  answered: boolean;
  /** Full URL of the models listing that responded. */
  url: string | null;
  error: string | null;
}

/**
 * Try `{base}/v1/models`, then `{base}/models`, using the provider's auth headers.
 *
 * `storedBase` is the literal value from `providers.json`; probe paths are built
 * from it, not from `resolveBaseUrl`, so a host-only Ollama address still hits `/v1`.
 */
export async function runAddressProbe(
  endpoint: Omit<HttpEndpoint, 'baseUrl'>,
  storedBase: string,
): Promise<AddressProbeResult> {
  const root = normalizeBaseUrlInput(storedBase).replace(/\/+$/, '');
  const probeEndpoint: HttpEndpoint = { ...endpoint, baseUrl: root };
  const paths = ['/v1/models', '/models'] as const;
  let lastError: string | null = null;
  for (const path of paths) {
    try {
      await requestJson(probeEndpoint, path, {
        onHttpError: (res) => new Error(`${res.status} ${res.statusText}`),
        onTransportError: (e) => new Error(e instanceof Error ? e.message : String(e)),
      });
      return { answered: true, url: `${root}${path}`, error: null };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { answered: false, url: null, error: lastError };
}
