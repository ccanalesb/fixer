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
export {
  resolveOpenLibraryPaths,
  resolveOpenLibraryPathsForCli,
  type OpenLibraryPaths,
} from '../open-library.js';
