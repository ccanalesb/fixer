/**
 * Read capture metadata from photo files with exiftool-vendored.
 */
import { statSync } from 'node:fs';
import { ExifTool, type Tags } from 'exiftool-vendored';
import { generateRecordKey } from '../lightroom/reader.js';
import type { CatalogRecord } from '../lightroom/reader.js';
import type { ResolvedFolderPhoto } from './walk.js';
import { applyFolderXmpMetadata, type FolderXmpMetadata } from './xmp-metadata.js';

const WALL_CLOCK_FIELDS = ['DateTimeOriginal', 'CreateDate', 'DateTimeDigitized'] as const;

export const FOLDER_EXIF_WORKERS = Math.max(1, Number(process.env.FOLDER_EXIF_WORKERS ?? '4'));

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatLocalDate(d: Date): string {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

function tagWallClock(tags: Tags, field: (typeof WALL_CLOCK_FIELDS)[number]): string | null {
  const value = tags[field];
  if (value == null) return null;
  const raw = typeof value === 'string' ? value : String(value);
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw);
  if (m) {
    return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(raw);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}:${iso[6]}`;
  return null;
}

export function captureDateFromTags(tags: Tags, filepath: string): string {
  for (const field of WALL_CLOCK_FIELDS) {
    const parsed = tagWallClock(tags, field);
    if (parsed) return parsed;
  }
  try {
    return formatLocalDate(statSync(filepath).mtime);
  } catch {
    return '';
  }
}

export function folderExifStartupErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();
  const mentionsPerl = lower.includes('perl');
  const spawnMissing =
    lower.includes('enoent') || lower.includes('not found') || lower.includes('spawn');
  if (spawnMissing && (mentionsPerl || lower.includes('exiftool'))) {
    if (process.platform === 'linux') {
      return (
        'exiftool failed to start: install the perl package ' +
        '(folder catalogs read photo metadata through exiftool-vendored).'
      );
    }
    return (
      'exiftool failed to start: Perl was not found ' +
      '(folder catalogs need a Perl interpreter for exiftool-vendored).'
    );
  }
  return `exiftool failed to start: ${raw}`;
}

export interface FolderExifSession {
  maxProcs: number;
  ensureReady: () => Promise<string | null>;
  read: (filepath: string) => Promise<Tags>;
  readParallel: (paths: readonly string[]) => Promise<Map<string, Tags>>;
  end: () => Promise<void>;
}

/** One ExifTool pool per folder sync — workers match `FOLDER_EXIF_WORKERS`. */
export function createFolderExifSession(): FolderExifSession {
  const maxProcs = FOLDER_EXIF_WORKERS;
  const tool = new ExifTool({ maxProcs });
  let startupError: string | null | undefined;
  async function ensureReady(): Promise<string | null> {
    if (startupError !== undefined) return startupError;
    try {
      await tool.version();
      startupError = null;
    } catch (error) {
      startupError = folderExifStartupErrorMessage(error);
    }
    return startupError;
  }
  async function read(filepath: string): Promise<Tags> {
    try {
      return await tool.read(filepath);
    } catch {
      return {} as Tags;
    }
  }
  return {
    maxProcs,
    ensureReady,
    read,
    async readParallel(paths: readonly string[]): Promise<Map<string, Tags>> {
      const out = new Map<string, Tags>();
      let index = 0;
      async function worker(): Promise<void> {
        for (;;) {
          const i = index;
          index += 1;
          if (i >= paths.length) return;
          const path = paths[i]!;
          out.set(path, await read(path));
        }
      }
      const workers = Math.min(maxProcs, paths.length || 1);
      await Promise.all(Array.from({ length: workers }, () => worker()));
      return out;
    },
    end: () => tool.end(),
  };
}

export function folderPhotoToCatalogRecord(
  photo: ResolvedFolderPhoto,
  tags: Tags,
  fileSize = 0,
  xmp?: FolderXmpMetadata,
): CatalogRecord {
  const date_taken = captureDateFromTags(tags, photo.filepath);
  const record: CatalogRecord = {
    id: photo.relPath as unknown as number,
    key: '',
    filename: photo.filename,
    filepath: photo.filepath,
    date_taken,
    rating: 0,
    pick: false,
    color_label: '',
    keywords: [],
    title: '',
    caption: '',
    copyright: '',
    camera_make: String(tags.Make ?? ''),
    camera_model: String(tags.Model ?? ''),
    lens: String(tags.LensModel ?? tags.Lens ?? ''),
    focal_length: tags.FocalLength ?? '',
    aperture: tags.FNumber ?? tags.Aperture ?? '',
    shutter_speed: tags.ShutterSpeed ?? tags.ExposureTime ?? '',
    iso: Number(tags.ISO ?? 0) || 0,
    gps_latitude: null,
    gps_longitude: null,
    width: Number(tags.ImageWidth ?? tags.ExifImageWidth ?? 0) || 0,
    height: Number(tags.ImageHeight ?? tags.ExifImageHeight ?? 0) || 0,
    file_size: fileSize,
    orientation: null,
  };
  record.key = generateRecordKey(record);
  if (xmp) applyFolderXmpMetadata(record, xmp);
  return record;
}

/** Last path in sorted order wins when two files share a key. */
export function buildFolderCatalogRecords(
  photos: readonly ResolvedFolderPhoto[],
  tagsByPath: ReadonlyMap<string, Tags>,
  sizeByPath?: ReadonlyMap<string, number>,
  xmpByRelPath?: ReadonlyMap<string, FolderXmpMetadata>,
): CatalogRecord[] {
  const byKey = new Map<string, CatalogRecord>();
  for (const photo of photos) {
    const tags = tagsByPath.get(photo.filepath) ?? ({} as Tags);
    const size = sizeByPath?.get(photo.filepath) ?? 0;
    const xmp = xmpByRelPath?.get(photo.relPath);
    const record = folderPhotoToCatalogRecord(photo, tags, size, xmp);
    byKey.set(record.key, record);
  }
  return [...byKey.values()];
}
