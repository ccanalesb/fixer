import { z } from '@hono/zod-openapi';

export const LrWritebackSettingsSchema = z
  .object({
    write_stars: z.boolean(),
    write_reject: z.boolean(),
    stars_profile_slug: z.string().nullable(),
    active_profile_slugs: z.array(z.string()),
    active_profiles: z.array(z.object({ slug: z.string(), name: z.string() }).strict()),
    catalog_write_available: z.boolean(),
    catalog_write_unavailable_reason: z.string().nullable(),
    counts: z.object({
      stars: z.object({
        pending: z.number().int(),
        written: z.number().int(),
      }),
      reject: z.object({
        pending: z.number().int(),
        written: z.number().int(),
      }),
    }),
  })
  .strict()
  .openapi('LrWritebackSettingsResponse');

export const LrWritebackWriteResponse = z
  .object({
    job_id: z.string(),
  })
  .strict()
  .openapi('LrWritebackWriteResponse');

export const LrWritebackSettingsPatchSchema = z
  .object({
    write_stars: z.boolean().optional(),
    write_reject: z.boolean().optional(),
    stars_profile_slug: z.string().nullable().optional(),
  })
  .strict();

export const LrWritebackPhotoDetailSchema = z
  .object({
    image_key: z.string(),
    rating: z
      .object({
        live: z.number().nullable(),
        app_wrote: z.boolean(),
        before_label: z.string().nullable(),
        undo_available: z.boolean(),
        user_changed: z.boolean(),
      })
      .strict(),
    flag: z
      .object({
        live_pick: z.number().nullable(),
        app_wrote_reject: z.boolean(),
        undo_available: z.boolean(),
        user_changed: z.boolean(),
      })
      .strict(),
    keywords: z.array(z.string()),
    strong_dimensions_line: z.string().nullable(),
  })
  .strict()
  .openapi('LrWritebackPhotoDetailResponse');
