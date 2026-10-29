import { writeFileSync } from 'node:fs';

export interface SeedModelRow {
  provider_id: string;
  model_id: string;
  model_name: string;
  vision?: number;
  image_refused_at?: string | null;
  image_refused_reason?: string | null;
  origin?: 'config' | 'user';
}

export function writeNewShapeProviders(
  path: string,
  opts: {
    providers: Record<string, unknown>;
    defaults?: Record<string, unknown>;
    fallback_order?: string[];
    retry_defaults?: Record<string, unknown>;
  },
): void {
  writeFileSync(
    path,
    JSON.stringify(
      {
        retry_defaults: opts.retry_defaults ?? {
          max_retries: 3,
          backoff_seconds: [2, 8, 32],
        },
        providers: opts.providers,
        defaults: opts.defaults ?? { description: { provider: 'local', model: null } },
        fallback_order: opts.fallback_order ?? ['local', 'cloud'],
      },
      null,
      2,
    ),
  );
}

export const LOCAL_PROVIDER = {
  name: 'Local',
  protocol: 'openai',
  enabled: true,
  tool_calling: false,
  base_url: { from: 'literal', value: 'http://127.0.0.1:1/v1' },
  auth: { mode: 'bearer', secret: { from: 'literal', value: 'local-key' } },
};

export const CLOUD_PROVIDER = {
  name: 'Cloud',
  protocol: 'openai',
  enabled: true,
  tool_calling: true,
  base_url: { from: 'literal', value: 'http://127.0.0.1:1/v1' },
  auth: { mode: 'bearer', secret: { from: 'env', value: 'LT_TEST_CLOUD_KEY' } },
};

export const DEFAULT_LOCAL_MODELS: SeedModelRow[] = [
  { provider_id: 'local', model_id: 'small', model_name: 'Small', vision: 1 },
  {
    provider_id: 'local',
    model_id: 'vendor/big',
    model_name: 'Big',
    vision: 0,
    image_refused_at: '2020-01-01T00:00:00.000Z',
    image_refused_reason: 'declared without image input',
  },
  { provider_id: 'cloud', model_id: 'vision-1', model_name: 'Vision One', vision: 1 },
];
