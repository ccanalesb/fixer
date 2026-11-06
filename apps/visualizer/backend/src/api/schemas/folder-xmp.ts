import { z } from '@hono/zod-openapi';

const FolderXmpFieldSource = z
  .object({
    source: z.string().nullable(),
  })
  .strict();

export const FolderXmpDetailResponse = z
  .object({
    image_key: z.string(),
    file_missing: z.boolean(),
    no_metadata_hint: z.boolean(),
    sidecar_order: z
      .array(
        z
          .object({
            basename: z.string(),
            read_order: z.int(),
          })
          .strict(),
      )
      .default([]),
    secondary_sidecar_note: z
      .object({
        basename: z.string(),
        read_after_basename: z.string(),
      })
      .strict()
      .nullable(),
    rating: FolderXmpFieldSource.extend({ display: z.string() }).strict(),
    reject: FolderXmpFieldSource.extend({ display: z.string().nullable() }).strict(),
    label: FolderXmpFieldSource.extend({ value: z.string().nullable() }).strict(),
    keywords: FolderXmpFieldSource.extend({ values: z.array(z.string()) }).strict(),
    title: FolderXmpFieldSource.extend({ value: z.string().nullable() }).strict(),
    caption: FolderXmpFieldSource.extend({ value: z.string().nullable() }).strict(),
    copyright: FolderXmpFieldSource.extend({ value: z.string().nullable() }).strict(),
  })
  .strict()
  .openapi('FolderXmpDetailResponse');
