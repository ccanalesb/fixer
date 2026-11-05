/**
 * Where job handlers find `library.db` — same resolution as the API (`config.ts`).
 */
export {
  describeLibraryDb,
  requireLibraryDb,
  resolveLibraryDb,
  type LibraryDbSource,
  type LibraryDbStatus,
} from '../config.js';
