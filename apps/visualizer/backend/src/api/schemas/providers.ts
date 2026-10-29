/** Providers API models. */
import { z } from '@hono/zod-openapi';

export const ProviderModelSource = z.enum(['config', 'discovered', 'user']);

export const Provider = z
  .object({
    id: z.string(),
    name: z.string(),
    available: z.boolean(),
    tool_calling: z.boolean(),
  })
  .strict()
  .openapi('Provider');

export const ProviderModel = z
  .object({
    id: z.string(),
    name: z.string(),
    source: ProviderModelSource,
    vision: z.boolean().nullish(),
    image_refused_reason: z.string().nullish(),
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
