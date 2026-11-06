/**
 * Rebuild a preview for change detection; mark descriptions, scores and CLIP stale when phash differs.
 */
import { unlink } from 'node:fs/promises';
import type { Db } from '../db/connection.js';
import { getImageOrientation } from '../db/library/catalog.js';
import { getVisionCachedImage } from '../db/library/vision-cache.js';
import { markVisionOutputsStale } from '../db/library/vision-stale.js';
import { libraryWrite } from '../db/library/write.js';
import { compressImage, getViewablePathManaged } from '../imaging/image-prep.js';
import { remainingOrientation } from '../imaging/orientation.js';
import { phashFromFile } from '../imaging/phash-file.js';
import { getOrCreateCachedImage } from '../vision/vision-cache.js';

export async function markStaleIfPreviewPhashChanged(
  db: Db,
  key: string,
  filepath: string,
): Promise<boolean> {
  const cached = getVisionCachedImage(db, key);
  const oldPhash = cached?.phash ?? null;
  const orientation = getImageOrientation(db, key);

  const viewable = await getViewablePathManaged(filepath);
  const tempFiles: string[] = [];
  if (viewable.isTemp) tempFiles.push(viewable.path);

  try {
    const compressed = await compressImage(viewable.path, {
      orientation: remainingOrientation(orientation, viewable.orientation),
    });
    if (compressed !== viewable.path) tempFiles.push(compressed);

    const newPhash = await phashFromFile(viewable.path);
    if (!newPhash) return false;
    if (oldPhash !== null && oldPhash === newPhash) return false;
    if (oldPhash !== null) {
      libraryWrite(db, () => markVisionOutputsStale(db, [key]));
      await getOrCreateCachedImage(db, key, filepath);
      return true;
    }
    return false;
  } finally {
    for (const tf of tempFiles) {
      await unlink(tf).catch(() => undefined);
    }
  }
}
