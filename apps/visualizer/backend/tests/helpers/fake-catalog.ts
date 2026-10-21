/**
 * A real `.lrcat` on disk, holding the slice of the Lightroom schema the metadata
 * join touches.
 *
 * Exercises the join, column coalescing, and catalog key format. Synced keys must
 * match the library's real key count (43,451 in the production corpus).
 */
import Database from 'better-sqlite3';

export interface CatalogFile {
  id: number;
  baseName: string;
  extension?: string;
  captureTime?: string | null;
  rating?: number | null;
  pick?: number | null;
  keywords?: string[];
  gpsLatitude?: number | null;
  focalLength?: number | null;
  caption?: string | null;
  /** `Adobe_images.orientation`; Lightroom writes `AB` for an unturned photo. */
  orientation?: string | null;
}

export interface FakeCatalogOptions {
  /**
   * Where the catalog thinks the photos live, with a trailing separator. The
   * synced `filepath` is this plus `2024/` plus the file's name, so a test that
   * needs the files to exist points this at its own temp directory.
   */
  rootPath?: string;
}

/**
 * Write a catalog holding `files`.
 *
 * `Adobe_images` is keyed separately from `AgLibraryFile` on purpose: the sync
 * diffs on the file id while EXIF and IPTC hang off the image id, and swapping
 * them silently returns another photo's metadata.
 */
export function makeFakeCatalog(
  path: string,
  files: readonly CatalogFile[],
  opts: FakeCatalogOptions = {},
): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE AgLibraryRootFolder (id_local INTEGER PRIMARY KEY, absolutePath TEXT);
    CREATE TABLE AgLibraryFolder (
      id_local INTEGER PRIMARY KEY, rootFolder INTEGER, pathFromRoot TEXT
    );
    CREATE TABLE AgLibraryFile (
      id_local INTEGER PRIMARY KEY, folder INTEGER, baseName TEXT, extension TEXT
    );
    CREATE TABLE Adobe_images (
      id_local INTEGER PRIMARY KEY, rootFile INTEGER, rating REAL, pick REAL,
      colorLabels TEXT, fileWidth INTEGER, fileHeight INTEGER, captureTime TEXT,
      orientation TEXT, masterImage INTEGER
    );
    CREATE TABLE AgHarvestedExifMetadata (
      image INTEGER, aperture REAL, focalLength REAL, shutterSpeed REAL,
      isoSpeedRating REAL, gpsLatitude REAL, gpsLongitude REAL
    );
    CREATE TABLE AgLibraryIPTC (image INTEGER, caption TEXT, copyright TEXT);
    CREATE TABLE AgLibraryKeyword (
      id_local INTEGER PRIMARY KEY, id_global TEXT, name TEXT, lc_name TEXT,
      dateCreated TEXT, keywordType INTEGER
    );
    CREATE TABLE AgLibraryKeywordImage (image INTEGER, tag INTEGER);
    INSERT INTO AgLibraryFolder (id_local, rootFolder, pathFromRoot) VALUES (1, 1, '2024/');
  `);
  db.prepare('INSERT INTO AgLibraryRootFolder (id_local, absolutePath) VALUES (1, ?)').run(
    opts.rootPath ?? '/Volumes/photos/',
  );

  const insertFile = db.prepare(
    'INSERT INTO AgLibraryFile (id_local, folder, baseName, extension) VALUES (?, 1, ?, ?)',
  );
  const insertImage = db.prepare(
    `INSERT INTO Adobe_images
       (id_local, rootFile, rating, pick, colorLabels, fileWidth, fileHeight, captureTime, orientation)
     VALUES (?, ?, ?, ?, 'blue', 6000, 4000, ?, ?)`,
  );
  const insertExif = db.prepare(
    `INSERT INTO AgHarvestedExifMetadata
       (image, aperture, focalLength, shutterSpeed, isoSpeedRating, gpsLatitude, gpsLongitude)
     VALUES (?, 2.8, ?, 0.004, 400, ?, -70.65)`,
  );
  const insertIptc = db.prepare(
    "INSERT INTO AgLibraryIPTC (image, caption, copyright) VALUES (?, ?, '')",
  );
  const insertKeyword = db.prepare('INSERT INTO AgLibraryKeyword (id_local, name) VALUES (?, ?)');
  const linkKeyword = db.prepare('INSERT INTO AgLibraryKeywordImage (image, tag) VALUES (?, ?)');

  let keywordId = 0;
  for (const f of files) {
    // Image ids deliberately in a different range, so a file/image id mix-up fails.
    const imageId = 900_000 + f.id;
    insertFile.run(f.id, f.baseName, f.extension ?? 'jpg');
    insertImage.run(
      imageId,
      f.id,
      f.rating ?? null,
      f.pick ?? null,
      f.captureTime === undefined ? '2024-06-01T12:00:00' : f.captureTime,
      f.orientation === undefined ? 'AB' : f.orientation,
    );
    insertExif.run(imageId, f.focalLength ?? 35, f.gpsLatitude ?? 42.36);
    insertIptc.run(imageId, f.caption ?? null);
    for (const name of f.keywords ?? []) {
      keywordId += 1;
      insertKeyword.run(keywordId, name);
      linkKeyword.run(imageId, keywordId);
    }
  }
  db.close();
}
