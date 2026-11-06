/**
 * XMP/IPTC field values and per-field sources for the folder-catalog image modal tab.
 */
import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { Tags } from 'exiftool-vendored';
import { getLibraryMeta } from '../db/library/bootstrap.js';
import type { Db } from '../db/connection.js';
import { getImage } from '../db/library/catalog.js';
import { CATALOG_KIND_META_KEY, CATALOG_PATH_META_KEY } from '../catalog-library.js';
import { AUTO_REJECT_KEYWORD, AUTO_STARS_KEYWORD } from '../lightroom/writeback-catalog-writer.js';
import { createFolderExifSession, type FolderExifSession } from './exif-read.js';
import { lstatPathsParallel } from './lstat-parallel.js';
import { resolveFolderPhotoAtPath, stemSidecarAmbiguousForDir } from './resolve-photo.js';
import {
  finalizeFolderXmpMetadata,
  keywordsFromTags,
  metadataSourcePathsInOrder,
  partialFromTags,
  stringField,
  type FolderXmpMetadata,
} from './xmp-metadata.js';
import { pathUnderCatalogRoot } from './path-under-root.js';
import { sidecarPathsForPhoto } from './xmp-sidecars.js';
import type { ResolvedFolderPhoto } from './walk.js';

type MetadataField = keyof FolderXmpMetadata;

const FIELD_ORDER: MetadataField[] = [
  'rating',
  'pick',
  'color_label',
  'keywords',
  'title',
  'caption',
  'copyright',
];

export interface FolderXmpFieldRow {
  source: string | null;
}

export interface FolderXmpDetail {
  image_key: string;
  file_missing: boolean;
  no_metadata_hint: boolean;
  sidecar_order: { basename: string; read_order: number }[];
  /** Second or later sidecar beside the photo, read after the first in the list. */
  secondary_sidecar_note: { basename: string; read_after_basename: string } | null;
  rating: FolderXmpFieldRow & { display: string };
  reject: FolderXmpFieldRow & { display: string | null };
  label: FolderXmpFieldRow & { value: string | null };
  keywords: FolderXmpFieldRow & { values: string[] };
  title: FolderXmpFieldRow & { value: string | null };
  caption: FolderXmpFieldRow & { value: string | null };
  copyright: FolderXmpFieldRow & { value: string | null };
}

type FieldSources = Partial<Record<MetadataField, string>>;

function autoKeywordSuffix(tags: Tags): string {
  const kws = keywordsFromTags(tags);
  if (!kws) return '';
  if (kws.includes(AUTO_STARS_KEYWORD) || kws.includes(AUTO_REJECT_KEYWORD)) {
    return ' (written by the app)';
  }
  return '';
}

function tagPresent(value: unknown): boolean {
  if (value == null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function embeddedSourceForField(tags: Tags, field: MetadataField): string {
  if (field === 'keywords') {
    if (tagPresent(tags.Subject)) return 'embedded XMP';
    if (tagPresent(tags.Keywords)) return 'IPTC Keywords';
  }
  if (field === 'caption') {
    const desc = stringField(tags, 'Description', 'XMP:Description');
    if (desc != null) return 'embedded XMP';
    if (stringField(tags, 'Caption-Abstract') != null) return 'IPTC Caption-Abstract';
  }
  return 'embedded XMP';
}

function sourceLabelForRead(path: string, tags: Tags, field: MetadataField): string {
  const suffix =
    (field === 'rating' || field === 'pick') && autoKeywordSuffix(tags) ? autoKeywordSuffix(tags) : '';
  if (path.endsWith('.xmp')) {
    return `sidecar ${basename(path)}${suffix}`;
  }
  return `${embeddedSourceForField(tags, field)}${suffix}`;
}

function partialAndSourcesFromTags(
  tags: Tags,
  sourcePath: string,
): { partial: Partial<FolderXmpMetadata>; sources: FieldSources } {
  const partial = partialFromTags(tags);
  const sources: FieldSources = {};
  for (const field of FIELD_ORDER) {
    if (!(field in partial)) continue;
    sources[field] = sourceLabelForRead(sourcePath, tags, field);
  }
  return { partial, sources };
}

async function readWithSources(
  session: FolderExifSession,
  photo: ResolvedFolderPhoto,
  ambiguousStemSidecarDirs: ReadonlySet<string>,
  statsByPath: Awaited<ReturnType<typeof lstatPathsParallel>>,
): Promise<{ meta: FolderXmpMetadata; sources: FieldSources; readOrder: string[] }> {
  const readOrder = metadataSourcePathsInOrder(photo, ambiguousStemSidecarDirs, statsByPath);
  const merged: Partial<FolderXmpMetadata> = {};
  const sources: FieldSources = {};
  for (const path of readOrder) {
    const tags = await session.read(path);
    const { partial, sources: fromPath } = partialAndSourcesFromTags(tags, path);
    for (const field of FIELD_ORDER) {
      if (field in merged) continue;
      if (!(field in partial)) continue;
      (merged as Record<string, unknown>)[field] = partial[field];
      const src = fromPath[field];
      if (src) sources[field] = src;
    }
  }
  return { meta: finalizeFolderXmpMetadata(merged), sources, readOrder };
}

function sidecarBasenamesOnDisk(
  photo: ResolvedFolderPhoto,
  ambiguousStemSidecarDirs: ReadonlySet<string>,
): string[] {
  return sidecarPathsForPhoto(photo, ambiguousStemSidecarDirs)
    .filter((p) => existsSync(p))
    .map((p) => basename(p));
}

function missingFileDetail(imageKey: string): FolderXmpDetail {
  return {
    image_key: imageKey,
    file_missing: true,
    no_metadata_hint: false,
    sidecar_order: [],
    secondary_sidecar_note: null,
    rating: { display: 'no rating', source: null },
    reject: { display: null, source: null },
    label: { value: null, source: null },
    keywords: { values: [], source: null },
    title: { value: null, source: null },
    caption: { value: null, source: null },
    copyright: { value: null, source: null },
  };
}

function pathsUnderCatalogRoot(catalogRoot: string, paths: readonly string[]): boolean {
  return paths.every((p) => p && pathUnderCatalogRoot(catalogRoot, p));
}

function buildDisplayRows(
  meta: FolderXmpMetadata,
  sources: FieldSources,
  sidecarBasenames: string[],
): Pick<
  FolderXmpDetail,
  | 'rating'
  | 'reject'
  | 'label'
  | 'keywords'
  | 'title'
  | 'caption'
  | 'copyright'
  | 'no_metadata_hint'
  | 'secondary_sidecar_note'
  | 'sidecar_order'
> {
  const sidecar_order = sidecarBasenames.map((name, i) => ({ basename: name, read_order: i + 1 }));
  const secondary_sidecar_note =
    sidecar_order.length >= 2
      ? {
          basename: sidecar_order[1]!.basename,
          read_after_basename: sidecar_order[0]!.basename,
        }
      : null;

  const no_metadata_hint =
    sidecarBasenames.length === 0 && Object.keys(sources).length === 0;

  const ratingDisplay = meta.rating >= 1 ? `${meta.rating}★` : 'no rating';

  const rejectDisplay = meta.pick === -1 ? 'Rejected' : null;

  return {
    sidecar_order,
    secondary_sidecar_note,
    no_metadata_hint,
    rating: { display: ratingDisplay, source: sources.rating ?? null },
    reject: {
      display: rejectDisplay,
      source: meta.pick === -1 ? (sources.pick ?? sources.rating ?? null) : null,
    },
    label: { value: meta.color_label || null, source: sources.color_label ?? null },
    keywords: { values: meta.keywords, source: sources.keywords ?? null },
    title: { value: meta.title || null, source: sources.title ?? null },
    caption: { value: meta.caption || null, source: sources.caption ?? null },
    copyright: { value: meta.copyright || null, source: sources.copyright ?? null },
  };
}

export async function buildFolderXmpDetail(db: Db, imageKey: string): Promise<FolderXmpDetail | null> {
  const kind = getLibraryMeta(db, CATALOG_KIND_META_KEY);
  if (kind !== 'folder') return null;

  const row = getImage(db, imageKey);
  if (!row) return null;

  const catalogRoot = getLibraryMeta(db, CATALOG_PATH_META_KEY);
  const filepath = String(row.filepath ?? '').trim();
  if (!catalogRoot || !filepath) {
    return missingFileDetail(imageKey);
  }

  if (!pathsUnderCatalogRoot(catalogRoot, [filepath])) {
    return missingFileDetail(imageKey);
  }

  const photo = resolveFolderPhotoAtPath(catalogRoot, filepath);
  if (!photo || !existsSync(photo.filepath)) {
    return missingFileDetail(imageKey);
  }

  const ambiguous = new Set<string>();
  const dir = dirname(photo.filepath);
  if (stemSidecarAmbiguousForDir(dir, photo.stem)) ambiguous.add(dir);

  const pathsToStat = metadataSourcePathsInOrder(photo, ambiguous, new Map());
  const readPaths = [photo.filepath, ...(photo.jpegFilepath ? [photo.jpegFilepath] : []), ...pathsToStat];
  if (!pathsUnderCatalogRoot(catalogRoot, readPaths)) {
    return missingFileDetail(imageKey);
  }

  const statsByPath = await lstatPathsParallel(pathsToStat, 4);

  const session = createFolderExifSession();
  try {
    const { meta, sources, readOrder } = await readWithSources(session, photo, ambiguous, statsByPath);
    const sidecarPaths = readOrder.filter((p) => p.endsWith('.xmp') && existsSync(p));
    const sidecarBasenames = sidecarPaths.map((p) => basename(p));
    const rows = buildDisplayRows(meta, sources, sidecarBasenames);
    return {
      image_key: imageKey,
      file_missing: false,
      ...rows,
    };
  } finally {
    await session.end();
  }
}
