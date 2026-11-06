/**
 * Ratings, labels and keywords from XMP sidecars, embedded XMP and IPTC for folder catalogs.
 */
import type { Tags } from 'exiftool-vendored';
import type { CatalogRecord } from '../lightroom/reader.js';
import type { FolderExifSession } from './exif-read.js';
import type { FileStatSnapshot } from './lstat-parallel.js';
import type { ResolvedFolderPhoto } from './walk.js';
import { assignCatalogPick } from './catalog-pick.js';
import { sidecarPathsForFile } from './xmp-sidecars.js';

export interface FolderXmpMetadata {
  rating: number;
  pick: number;
  color_label: string;
  keywords: string[];
  title: string;
  caption: string;
  copyright: string;
}

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

export function ratingFromTags(tags: Tags): number | null {
  const raw = tags.Rating ?? (tags as Record<string, unknown>)['XMP:Rating'];
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n === -1) return -1;
  if (n >= 1 && n <= 5) return Math.trunc(n);
  if (n === 0) return 0;
  return null;
}

export function labelFromTags(tags: Tags): string | null {
  const raw = tags.Label ?? (tags as Record<string, unknown>)['XMP:Label'];
  if (raw == null || raw === '') return null;
  return String(raw);
}

export function keywordsFromTags(tags: Tags): string[] | null {
  const subject = tags.Subject;
  if (subject != null) {
    if (Array.isArray(subject)) {
      const flat = subject.map((s) => String(s).trim()).filter(Boolean);
      if (flat.length) return flat;
    } else {
      const flat = String(subject)
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (flat.length) return flat;
    }
  }
  const iptc = tags.Keywords;
  if (iptc != null && iptc !== '') {
    if (Array.isArray(iptc)) {
      const flat = iptc.map((s) => String(s).trim()).filter(Boolean);
      if (flat.length) return flat;
    } else {
      const flat = String(iptc)
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (flat.length) return flat;
    }
  }
  return null;
}

export function stringField(tags: Tags, ...keys: string[]): string | null {
  for (const key of keys) {
    const raw = (tags as Record<string, unknown>)[key];
    if (raw == null || raw === '') continue;
    return String(raw);
  }
  return null;
}

export function partialFromTags(tags: Tags): Partial<FolderXmpMetadata> {
  const out: Partial<FolderXmpMetadata> = {};
  const rating = ratingFromTags(tags);
  if (rating === -1) {
    out.rating = 0;
    out.pick = -1;
  } else if (rating != null && rating >= 1) {
    out.rating = rating;
    out.pick = 0;
  } else if (rating === 0) {
    out.rating = 0;
    out.pick = 0;
  }

  const label = labelFromTags(tags);
  if (label != null) out.color_label = label;

  const keywords = keywordsFromTags(tags);
  if (keywords != null) out.keywords = keywords;

  const title = stringField(tags, 'Title', 'XMP:Title');
  if (title != null) out.title = title;

  const caption = stringField(tags, 'Description', 'Caption-Abstract', 'XMP:Description');
  if (caption != null) out.caption = caption;

  const copyright = stringField(tags, 'Rights', 'XMP:Rights');
  if (copyright != null) out.copyright = copyright;

  return out;
}

function mergePartial(into: Partial<FolderXmpMetadata>, from: Partial<FolderXmpMetadata>): void {
  for (const field of FIELD_ORDER) {
    if (field in into) continue;
    const value = from[field];
    if (value === undefined) continue;
    if (field === 'keywords' && Array.isArray(value) && value.length === 0) continue;
    (into as Record<string, unknown>)[field] = value;
  }
}

function emptyMetadata(): FolderXmpMetadata {
  return {
    rating: 0,
    pick: 0,
    color_label: '',
    keywords: [],
    title: '',
    caption: '',
    copyright: '',
  };
}

export function finalizeFolderXmpMetadata(partial: Partial<FolderXmpMetadata>): FolderXmpMetadata {
  const merged: FolderXmpMetadata = { ...emptyMetadata(), ...partial, keywords: partial.keywords ?? [] };
  if (merged.pick === -1) merged.rating = 0;
  return merged;
}

function byMtimeDesc(statsByPath: ReadonlyMap<string, FileStatSnapshot>) {
  return (a: string, b: string): number => {
    const ma = statsByPath.get(a)?.mtimeMs ?? 0;
    const mb = statsByPath.get(b)?.mtimeMs ?? 0;
    return mb - ma || a.localeCompare(b);
  };
}

/**
 * Metadata source paths in the precedence order the reader applies: for a RAW+JPEG
 * pair all of the RAW's sources come first — its sidecars (newer mtime first), then
 * its embedded XMP/IPTC — and only then the JPEG's sidecars and embedded XMP/IPTC.
 * A lone photo is its sidecars (newer first) then its embedded XMP/IPTC.
 */
export function metadataSourcePathsInOrder(
  photo: ResolvedFolderPhoto,
  ambiguousStemSidecarDirs: ReadonlySet<string>,
  statsByPath: ReadonlyMap<string, FileStatSnapshot>,
): string[] {
  const order = byMtimeDesc(statsByPath);
  const rawSidecars = sidecarPathsForFile(photo.filepath, photo.stem, ambiguousStemSidecarDirs);
  rawSidecars.sort(order);
  const paths = [...rawSidecars, photo.filepath];
  if (photo.jpegFilepath) {
    const jpegSidecars = sidecarPathsForFile(photo.jpegFilepath, photo.stem, ambiguousStemSidecarDirs);
    jpegSidecars.sort(order);
    paths.push(...jpegSidecars, photo.jpegFilepath);
  }
  return [...new Set(paths)];
}

export async function readFolderPhotoXmpMetadata(
  session: FolderExifSession,
  photo: ResolvedFolderPhoto,
  ambiguousStemSidecarDirs: ReadonlySet<string>,
  statsByPath: ReadonlyMap<string, FileStatSnapshot>,
): Promise<FolderXmpMetadata> {
  const paths = metadataSourcePathsInOrder(photo, ambiguousStemSidecarDirs, statsByPath);
  const merged: Partial<FolderXmpMetadata> = {};
  for (const path of paths) {
    const tags = await session.read(path);
    mergePartial(merged, partialFromTags(tags));
  }
  return finalizeFolderXmpMetadata(merged);
}

export function applyFolderXmpMetadata(record: CatalogRecord, meta: FolderXmpMetadata): void {
  record.rating = meta.rating;
  assignCatalogPick(record, meta.pick === -1 ? -1 : 0);
  record.color_label = meta.color_label;
  record.keywords = meta.keywords;
  record.title = meta.title;
  record.caption = meta.caption;
  record.copyright = meta.copyright;
}
