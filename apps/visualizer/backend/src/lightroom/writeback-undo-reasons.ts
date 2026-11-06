import type { PickRatingWriteResult } from './writer.js';

export function folderUndoFailureReason(result: PickRatingWriteResult): string {
  switch (result) {
    case 'mtime_conflict':
      return 'The file changed while undo was running. Try again.';
    case 'readonly_error':
      return 'The file is read-only.';
    case 'skipped':
      return 'The file no longer holds what the app wrote.';
    case 'image_not_found':
      return 'Photo file not found.';
    default:
      return 'Undo could not write the file.';
  }
}
