/**
 * Register a System One provider pointing at a URL (e.g. a fake server) for tests.
 */
import { writeFileSync } from 'node:fs';
import { providerIdFromCullingUrl } from '../../src/providers/culling-provider-id.js';

export interface RegisterSystemOneProviderOpts {
  providersPath: string;
  url: string;
  name?: string;
  enabled?: boolean;
  apiKey?: string;
  id?: string;
}

export function registerSystemOneProvider(opts: RegisterSystemOneProviderOpts): string {
  const id = opts.id ?? providerIdFromCullingUrl(opts.url);
  const apiKey = opts.apiKey ?? '';
  writeFileSync(
    opts.providersPath,
    JSON.stringify(
      {
        providers: {
          [id]: {
            name: opts.name ?? 'Host',
            protocol: 'system_one',
            enabled: opts.enabled ?? true,
            base_url: { from: 'literal', value: opts.url.replace(/\/+$/, '') },
            auth: apiKey ? { mode: 'bearer', secret: { from: 'literal', value: apiKey } } : { mode: 'none' },
          },
        },
        defaults: {},
        fallback_order: [],
      },
      null,
      2,
    ),
  );
  return id;
}
