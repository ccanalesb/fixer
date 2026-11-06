/**
 * Rebuild a preview for change detection; mark descriptions, scores and CLIP stale when phash differs.
 */
import { unlink } from 'node:fs/promises';
import type { Db } from '../db/connection.js';
import { getImageOrientation } from '../db/library/catalog.js';
import { getVisionCachedImage } from '../db/library/vision-cache.js';
import { markVisionOutputsStale } from '../db/library/vision-stale.js';
import { libraryWrite } from '../db/library/write.js';
import { compressImage } from '../imaging/image-prep.js';
import { phashFromFile } from '../imaging/phash-file.js';

export async function markStaleIfPreviewPhashChanged(
  db: Db,
  key: string,
  filepath: string,
): Promise<boolean> {
  const cached = getVisionCachedImage(db, key);
  const oldPhash = cached?.phash ?? null;
  const orientation = getImageOrientation(db, key);
  const temp = await compressImage(filepath, { orientation });
  if (!temp) return false;
  try {
    const newPhash = await phashFromFile(temp);
    if (!newPhash) return false;
    if (oldPhash !== null && oldPhash === newPhash) return false;
    if (oldPhash !== null) {
      libraryWrite(db, () => markVisionOutputsStale(db, [key]));
      return true;
    }
    return false;
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}
