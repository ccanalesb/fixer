/**
 * One OpenAI-compatible JSON request.
 *
 * The registry's capability probes and the vision client both talk the same
 * dialect — bearer auth, the provider's extra headers, a per-provider timeout,
 * a JSON body — and used to spell it out separately. They do want different
 * failures out of it, though: a probe reports "unreachable, here is why" to the
 * UI, while a product call has to raise something `isRetryableError` and the
 * fallback cascade can classify. So the plumbing is shared and the error mapping
 * is the caller's, passed in rather than assumed.
 */

export interface HttpEndpoint {
  baseUrl: string;
  apiKey: string;
  authMode?: 'none' | 'bearer' | 'header';
  authHeaderName?: string;
  extraHeaders?: Record<string, string>;
  timeoutMs: number;
}

export interface RequestJsonOptions {
  method?: string;
  body?: unknown;
  /** Build the error for a non-2xx response. */
  onHttpError: (res: Response, bodyText: string) => Error;
  /** Build the error when no response arrived at all. Rethrows as-is by default. */
  onTransportError?: (e: unknown) => Error;
}

export async function requestJson(
  endpoint: HttpEndpoint,
  path: string,
  opts: RequestJsonOptions,
): Promise<unknown> {
  const base = endpoint.baseUrl.replace(/\/+$/, '');
  const hasBody = opts.body !== undefined;

  const authMode = endpoint.authMode ?? 'bearer';
  const authHeaders: Record<string, string> = {};
  if (authMode === 'bearer' && endpoint.apiKey) {
    authHeaders.Authorization = `Bearer ${endpoint.apiKey}`;
  } else if (authMode === 'header' && endpoint.authHeaderName && endpoint.apiKey) {
    authHeaders[endpoint.authHeaderName] = endpoint.apiKey;
  }

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: opts.method ?? (hasBody ? 'POST' : 'GET'),
      headers: {
        ...authHeaders,
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...(endpoint.extraHeaders ?? {}),
      },
      ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(endpoint.timeoutMs),
    });
  } catch (e) {
    throw opts.onTransportError ? opts.onTransportError(e) : e;
  }

  if (!res.ok) throw opts.onHttpError(res, await res.text());
  return res.json();
}
