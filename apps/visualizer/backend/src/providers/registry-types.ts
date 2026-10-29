export interface ValueRef {
  from: 'literal' | 'env';
  value: string;
}

export interface ProviderAuth {
  mode: 'none' | 'bearer' | 'header';
  header_name?: string;
  secret?: ValueRef;
}

export interface ProviderConfig {
  name: string;
  protocol: 'openai' | 'system_one';
  enabled?: boolean;
  tool_calling?: boolean;
  base_url: ValueRef;
  auth: ProviderAuth;
  extra_headers?: Record<string, string>;
  request_timeout_seconds?: number;
  retry?: Record<string, unknown>;
  model_order?: string[];
}

export interface ProviderModelEntry {
  id: string;
  name: string;
  vision?: boolean;
  source?: 'config' | 'discovered' | 'user';
  [key: string]: unknown;
}

export interface ProviderAuthSummary {
  mode: 'none' | 'bearer' | 'header';
  header_name?: string;
  has_key: boolean;
  secret_from?: 'literal' | 'env';
  env_var?: string;
  env_set?: boolean;
}

export interface ProviderAddressProbeSummary {
  answered: boolean;
  url?: string | null;
  probed_at: string;
  error?: string | null;
}

export interface ProviderSummary {
  id: string;
  name: string;
  available: boolean;
  tool_calling: boolean;
  enabled: boolean;
  base_url: ValueRef;
  auth: ProviderAuthSummary;
  address_probe: ProviderAddressProbeSummary | null;
}

export interface CreateProviderInput {
  name: string;
  base_url: string;
  auth: {
    mode: 'none' | 'bearer' | 'header';
    header_name?: string;
    key?: string;
  };
  extra_headers?: Record<string, string>;
}

export interface UpdateProviderInput {
  name?: string;
  base_url?: string;
  auth?: {
    mode?: 'none' | 'bearer' | 'header';
    header_name?: string;
    /** When set, replaces any existing secret with a literal value. */
    key?: string;
    /** Drop a stored literal or env reference without supplying a new key. */
    clear_key?: boolean;
  };
  enabled?: boolean;
  extra_headers?: Record<string, string>;
}

export interface DefaultsEntry {
  provider: string;
  model?: string | null;
}

export interface RegistryConfig {
  retry_defaults?: Record<string, unknown>;
  providers: Record<string, ProviderConfig>;
  defaults?: Record<string, DefaultsEntry>;
  fallback_order?: string[];
}

function providerLooksLegacy(p: Record<string, unknown>): boolean {
  return (
    'api_key' in p ||
    'api_key_env' in p ||
    'base_url_env' in p ||
    'base_url_default' in p ||
    ('base_url' in p && (typeof p.base_url === 'string' || p.base_url === null)) ||
    'auto_discover' in p ||
    'native_chat' in p ||
    'models' in p
  );
}

/** True when the on-disk file still uses pre-migration provider fields. */
export function isLegacyProvidersFile(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  const providers = (parsed as { providers?: unknown }).providers;
  if (!providers || typeof providers !== 'object') return false;
  for (const p of Object.values(providers as Record<string, unknown>)) {
    if (p && typeof p === 'object' && providerLooksLegacy(p as Record<string, unknown>)) {
      return true;
    }
  }
  return false;
}

/** Drop retired keys so a rewrite never puts them back. */
export function stripLegacyProviderFields(cfg: RegistryConfig): RegistryConfig {
  const providers: Record<string, ProviderConfig> = {};
  for (const [id, p] of Object.entries(cfg.providers)) {
    providers[id] = { ...p };
  }
  return { ...cfg, providers };
}
