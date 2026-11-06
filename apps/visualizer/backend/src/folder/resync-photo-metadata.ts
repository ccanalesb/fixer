/**
 * Re-read one folder-catalog photo's XMP into `library.db` after write-back writes
 * into it, recording its file stats so the next sync does not see an edit.
 */
import type { Db } from '../db/connection.js';
import {
  recordFolderCatalogFileSnapshot,
  updateFolderMetadataOnly,
} from '../db/library/folder-sync.js';
import { libraryWrite } from '../db/library/write.js';
import {
  createFolderExifSession,
  folderPhotoToCatalogRecord,
  type FolderExifSession,
} from './exif-read.js';
import { lstatPathsParallel } from './lstat-parallel.js';
import { resolveFolderPhotoAtPath } from './resolve-photo.js';
import { readFolderPhotoXmpMetadata } from './xmp-metadata.js';
import { findAmbiguousStemSidecarDirs, sidecarPathsForPhoto, sidecarSignature } from './xmp-sidecars.js';

/** Reads with `session` when given, else with one opened and closed here. */
export async function resyncFolderPhotoMetadata(
  catalogRoot: string,
  db: Db,
  imageKey: string,
  session?: FolderExifSession,
): Promise<void> {
  const row = db.prepare('SELECT filepath FROM images WHERE key = ?').get(imageKey) as
    | { filepath: string }
    | undefined;
  if (!row?.filepath) return;
  const photo = resolveFolderPhotoAtPath(catalogRoot, row.filepath);
  if (!photo) return;

  const ambiguous = findAmbiguousStemSidecarDirs([photo]);
  const sidecarPaths = sidecarPathsForPhoto(photo, ambiguous);
  const statsByPath = await lstatPathsParallel([photo.filepath, ...sidecarPaths]);
  const diskStat = statsByPath.get(photo.filepath);
  if (!diskStat?.readable) return;

  const exif = session ?? createFolderExifSession();
  try {
    const tags = await exif.read(photo.filepath);
    const xmp = await readFolderPhotoXmpMetadata(exif, photo, ambiguous, statsByPath);
    const record = folderPhotoToCatalogRecord(photo, tags, diskStat.size, xmp);
    const sideSig = sidecarSignature(sidecarPaths, statsByPath);
    libraryWrite(db, () => {
      updateFolderMetadataOnly(db, imageKey, record, sideSig);
      recordFolderCatalogFileSnapshot(db, imageKey, photo, ambiguous);
    });
  } finally {
    if (!session) await exif.end();
  }
}
