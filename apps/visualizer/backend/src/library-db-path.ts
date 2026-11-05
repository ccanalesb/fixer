/** Re-export so job code can import from a dedicated module without reaching into config. */
export {
  describeLibraryDb,
  requireLibraryDb,
  resolveLibraryDb,
  resolveLibraryDbLocation,
  type LibraryDbSource,
  type LibraryDbStatus,
} from './config.js';
