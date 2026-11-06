/** Lightroom config API models (`/api/config/*`). */
import { z } from '@hono/zod-openapi';

const CatalogKindSchema = z.enum(['lightroom', 'folder']);

export const ConfigCatalogGetResponse = z
  .object({
    catalog_path: z.string(),
    resolved_path: z.string(),
    exists: z.boolean(),
    catalog_kind: CatalogKindSchema,
    /** Photos in the library Fixer has for the configured catalog, when one exists. */
    photo_count: z.int().nullable(),
    /** Subfolders that contain photos under a folder catalog root. */
    folder_count: z.int().nullable(),
    /** Directories under a folder catalog root that could not be read on the last walk. */
    unreadable_directories: z.array(z.string()),
    /** Whether this host can open a native file dialog; macOS only for now. */
    picker_available: z.boolean(),
  })
  .strict()
  .openapi('ConfigCatalogGetResponse');

export const ConfigCatalogPickResponse = z
  .object({
    /** `null` when the dialog was dismissed without choosing anything. */
    catalog_path: z.string().nullable(),
  })
  .strict()
  .openapi('ConfigCatalogPickResponse');

export const ConfigCatalogPickFolderResponse = z
  .object({
    catalog_path: z.string().nullable(),
  })
  .strict()
  .openapi('ConfigCatalogPickFolderResponse');

const ConfigCatalogSideSummary = z
  .object({
    catalog_path: z.string(),
    resolved_path: z.string(),
    catalog_kind: CatalogKindSchema,
    display_name: z.string(),
    exists: z.boolean(),
    library_photo_count: z.int().nullable(),
    has_library: z.boolean(),
  })
  .strict();

export const ConfigCatalogChangePreviewRequest = z
  .object({ catalog_path: z.string() })
  .strict()
  .openapi('ConfigCatalogChangePreviewRequest');

export const ConfigCatalogChangePreviewResponse = z
  .object({
    unchanged: z.boolean(),
    current: ConfigCatalogSideSummary,
    next: ConfigCatalogSideSummary,
    ask_same_or_different: z.boolean(),
    jobs_to_cancel: z.array(
      z
        .object({
          id: z.string(),
          type: z.string(),
          status: z.string(),
        })
        .strict(),
    ),
  })
  .strict()
  .openapi('ConfigCatalogChangePreviewResponse');

export const ConfigCatalogPutRequest = z
  .object({
    catalog_path: z.string(),
    /** `update_path` keeps the current library; `switch` opens another (or a new empty one). */
    change: z.enum(['update_path', 'switch']),
  })
  .strict()
  .openapi('ConfigCatalogPutRequest');

export const ConfigCatalogPutResponse = z
  .object({
    catalog_path: z.string(),
    change: z.enum(['update_path', 'switch']),
    reopened_library: z.boolean(),
    library_photo_count: z.int().nullable(),
    catalog_sync_job_id: z.string().nullable(),
    cancelled_job_ids: z.array(z.string()),
    ok: z.boolean(),
  })
  .strict()
  .openapi('ConfigCatalogPutResponse');

export const ConfigStackDetectionGetResponse = z
  .object({ stack_burst_delta_ms: z.int() })
  .strict()
  .openapi('ConfigStackDetectionGetResponse');

export const ConfigStackDetectionPutRequest = z
  .object({ stack_burst_delta_ms: z.int() })
  .strict()
  .openapi('ConfigStackDetectionPutRequest');

export const ConfigStackDetectionPutResponse = z
  .object({
    stack_burst_delta_ms: z.int(),
    ok: z.boolean(),
  })
  .strict()
  .openapi('ConfigStackDetectionPutResponse');
