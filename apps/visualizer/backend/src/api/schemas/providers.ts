/** Providers API models. */
import { z } from '@hono/zod-openapi';

export const ProviderModelSource = z.enum(['config', 'discovered', 'user']);

export const ValueRef = z
  .object({
    from: z.enum(['literal', 'env']),
    value: z.string(),
  })
  .strict()
  .openapi('ValueRef');

export const ProviderAuthSummary = z
  .object({
    mode: z.enum(['none', 'bearer', 'header']),
    header_name: z.string().nullish(),
    has_key: z.boolean(),
    secret_from: z.enum(['literal', 'env']).nullish(),
    env_var: z.string().nullish(),
    env_set: z.boolean().nullish(),
  })
  .strict()
  .openapi('ProviderAuthSummary');

export const ProviderAddressProbe = z
  .object({
    answered: z.boolean(),
    url: z.string().nullish(),
    probed_at: z.string(),
    error: z.string().nullish(),
  })
  .strict()
  .openapi('ProviderAddressProbe');

export const Provider = z
  .object({
    id: z.string(),
    name: z.string(),
    available: z.boolean(),
    tool_calling: z.boolean(),
    enabled: z.boolean(),
    base_url: ValueRef,
    auth: ProviderAuthSummary,
    address_probe: ProviderAddressProbe.nullish(),
  })
  .strict()
  .openapi('Provider');

export const ProviderCreateBody = z
  .object({
    name: z.string(),
    base_url: z.string(),
    auth: z
      .object({
        mode: z.enum(['none', 'bearer', 'header']),
        header_name: z.string().nullish(),
        key: z.string().nullish(),
      })
      .strict(),
    extra_headers: z.record(z.string(), z.string()).nullish(),
  })
  .strict()
  .openapi('ProviderCreateBody');

export const ProviderUpdateBody = z
  .object({
    name: z.string().nullish(),
    base_url: z.string().nullish(),
    enabled: z.boolean().nullish(),
    extra_headers: z.record(z.string(), z.string()).nullish(),
    auth: z
      .object({
        mode: z.enum(['none', 'bearer', 'header']).nullish(),
        header_name: z.string().nullish(),
        key: z.string().nullish(),
        clear_key: z.boolean().nullish(),
      })
      .strict()
      .nullish(),
  })
  .strict()
  .openapi('ProviderUpdateBody');

export const ProviderModel = z
  .object({
    id: z.string(),
    name: z.string(),
    source: ProviderModelSource,
    vision: z.boolean().nullish(),
  })
  .strict()
  .openapi('ProviderModel');

export const ProviderDefaultsEntry = z
  .object({ provider: z.string(), model: z.string().nullish() })
  .strict()
  .openapi('ProviderDefaultsEntry');

export const ProviderDefaults = z
  .object({ description: ProviderDefaultsEntry })
  .strict()
  .openapi('ProviderDefaults');

export const DescriptionModel = z
  .object({
    provider_id: z.string(),
    provider_name: z.string(),
    model_id: z.string(),
    model_name: z.string(),
    tool_calling: z.boolean(),
  })
  .strict()
  .openapi('DescriptionModel');

export const DescriptionModelsResponse = z
  .object({
    models: z.array(DescriptionModel),
    default_provider: z.string().nullish(),
    default_model: z.string().nullish(),
  })
  .strict()
  .openapi('DescriptionModelsResponse');

export const FallbackOrderResponse = z
  .object({ order: z.array(z.string()) })
  .strict()
  .openapi('FallbackOrderResponse');

export const ProviderHealthResponse = z
  .object({ reachable: z.boolean(), error: z.string().nullish() })
  .strict()
  .openapi('ProviderHealthResponse');

export const ProviderDeletedResponse = z
  .object({ deleted: z.boolean() })
  .strict()
  .openapi('ProviderDeletedResponse');

export const ProviderReorderSuccessResponse = z
  .object({ success: z.boolean() })
  .strict()
  .openapi('ProviderReorderSuccessResponse');

/**
 * Top-level JSON arrays, not wrapped objects — matching the wire format of
 * `GET /api/providers/` and `GET /api/providers/{id}/models`.
 */
export const ProviderListResponse = z.array(Provider).openapi('ProviderListResponse');
export const ProviderModelsListResponse = z
  .array(ProviderModel)
  .openapi('ProviderModelsListResponse');

export type ProviderModel = z.infer<typeof ProviderModel>;
