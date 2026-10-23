/** Models in this app API models (`/api/app-models*`). */
import { z } from '@hono/zod-openapi';

export const AppModel = z
  .object({
    /** The name this app's System One endpoint lists it under. */
    name: z.string(),
    /** The Hugging Face id or folder it is converted from. */
    source: z.string().nullable(),
    /** The Hugging Face commit; `null` for a folder, and while converting. */
    revision: z.string().nullable(),
    status: z.enum(['ready', 'converting']),
    /** The conversion job; `null` for a model converted by hand. */
    job_id: z.string().nullable(),
  })
  .strict()
  .openapi('AppModel');

export const AppModelsListResponse = z
  .object({
    models: z.array(AppModel),
    /** Whether this host can open a native folder dialog; macOS only for now. */
    picker_available: z.boolean(),
  })
  .strict()
  .openapi('AppModelsListResponse');

export const AppModelAddRequest = z
  .object({
    /** A folder in Hugging Face format on the backend's machine, or a Hugging Face id (`id` or `id@revision`). */
    source: z.string(),
  })
  .strict()
  .openapi('AppModelAddRequest');

export const AppModelAddResponse = z
  .object({ name: z.string(), job_id: z.string() })
  .strict()
  .openapi('AppModelAddResponse');

export const AppModelPickResponse = z
  .object({
    /** `null` when the dialog was dismissed without choosing anything. */
    path: z.string().nullable(),
  })
  .strict()
  .openapi('AppModelPickResponse');
