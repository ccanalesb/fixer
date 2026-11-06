import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initLibraryDb } from '../src/db/library/bootstrap.js';
import { createFolderExifSession } from '../src/folder/exif-read.js';
import { lstatPathsParallel } from '../src/folder/lstat-parallel.js';
import {
  metadataSourcePathsInOrder,
  readFolderPhotoXmpMetadata,
} from '../src/folder/xmp-metadata.js';
import { findAmbiguousStemSidecarDirs } from '../src/folder/xmp-sidecars.js';
import { syncFolderCatalog } from '../src/folder/sync.js';
import type { ResolvedFolderPhoto } from '../src/folder/walk.js';

const xmp = (body: string) =>
  `<?xml version='1.0'?><x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#' xmlns:xmp='http://ns.adobe.com/xap/1.0/' xmlns:dc='http://purl.org/dc/elements/1.1/'><rdf:Description rdf:about='' ${body}/></rdf:RDF></x:xmpmeta>`;

let dir: string;
let root: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-folder-xmp-'));
  root = join(dir, 'photos');
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('folder XMP metadata', () => {
  it('prefers the more recently modified sidecar over an older stem sidecar', async () => {
    const photoPath = join(root, 'pick.jpg');
    writeFileSync(photoPath, 'fake');
    const extSidecar = join(root, 'pick.jpg.xmp');
    const stemSidecar = join(root, 'pick.xmp');
    writeFileSync(extSidecar, xmp("xmp:Rating='5'"));
    writeFileSync(stemSidecar, xmp("xmp:Rating='1'"));
    utimesSync(extSidecar, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    utimesSync(stemSidecar, new Date('2025-01-01T00:00:00Z'), new Date('2025-01-01T00:00:00Z'));

    const photo: ResolvedFolderPhoto = {
      filepath: photoPath,
      relPath: 'pick.jpg',
      filename: 'pick',
      stem: 'pick',
    };
    const stats = await lstatPathsParallel([photoPath, extSidecar, stemSidecar], 4);
    const ambiguous = findAmbiguousStemSidecarDirs([photo]);
    const order = metadataSourcePathsInOrder(photo, ambiguous, stats);
    expect(order[0]).toBe(stemSidecar);

    const session = createFolderExifSession();
    try {
      const meta = await readFolderPhotoXmpMetadata(session, photo, [photo], stats);
      expect(meta.rating).toBe(1);
    } finally {
      await session.end();
    }
  });

  it('stores reject as pick -1 and maps labels and keywords', async () => {
    writeFileSync(join(root, 'one.jpg'), 'fake');
    writeFileSync(
      join(root, 'one.jpg.xmp'),
      xmp("xmp:Rating='-1' xmp:Label='Blue' dc:subject='alpha, beta' dc:title='My title'"),
    );
    const db = initLibraryDb(join(dir, 'library.db'));
    try {
      await syncFolderCatalog(root, db, {});
      const row = db.prepare('SELECT rating, pick, color_label, keywords, title FROM images').get() as {
        rating: number;
        pick: number;
        color_label: string;
        keywords: string;
        title: string;
      };
      expect(row.rating).toBe(0);
      expect(row.pick).toBe(-1);
      expect(row.color_label).toBe('Blue');
      expect(JSON.parse(row.keywords)).toEqual(['alpha', 'beta']);
      expect(row.title).toBe('My title');
    } finally {
      db.close();
    }
  });

  it('treats absent or zero XMP rating as unrated', async () => {
    writeFileSync(join(root, 'plain.jpg'), 'fake');
    writeFileSync(
      join(root, 'plain.jpg.xmp'),
      xmp("xmp:Label='Green'"),
    );
    const db = initLibraryDb(join(dir, 'library.db'));
    try {
      await syncFolderCatalog(root, db, {});
      const row = db.prepare('SELECT rating, pick, color_label FROM images').get() as {
        rating: number;
        pick: number;
        color_label: string;
      };
      expect(row.rating).toBe(0);
      expect(row.pick).toBe(0);
      expect(row.color_label).toBe('Green');
    } finally {
      db.close();
    }
  });
});
