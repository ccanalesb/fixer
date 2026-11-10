import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initLibraryDb } from '../src/db/library/bootstrap.js';
import { createFolderExifSession } from '../src/folder/exif-read.js';
import { lstatPathsParallel } from '../src/folder/lstat-parallel.js';
import {
  metadataSourcePathsInOrder,
  partialFromTags,
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
      const meta = await readFolderPhotoXmpMetadata(session, photo, ambiguous, stats);
      expect(meta.rating).toBe(1);
    } finally {
      await session.end();
    }
  });

  it("orders a pair's RAW sources before the JPEG's even when a JPEG sidecar is newer", async () => {
    const rawPath = join(root, 'img.cr2');
    const jpegPath = join(root, 'img.jpg');
    writeFileSync(rawPath, 'raw');
    writeFileSync(jpegPath, 'jpg');
    const rawSidecar = join(root, 'img.cr2.xmp');
    const jpegSidecar = join(root, 'img.jpg.xmp');
    writeFileSync(rawSidecar, 'x');
    writeFileSync(jpegSidecar, 'x');
    utimesSync(rawSidecar, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    utimesSync(jpegSidecar, new Date('2025-01-01T00:00:00Z'), new Date('2025-01-01T00:00:00Z'));

    const photo: ResolvedFolderPhoto = {
      filepath: rawPath,
      relPath: 'img.cr2',
      filename: 'img',
      stem: 'img',
      jpegFilepath: jpegPath,
    };
    const stemSidecar = join(root, 'img.xmp');
    const stats = await lstatPathsParallel(
      [rawPath, jpegPath, rawSidecar, jpegSidecar, stemSidecar],
      4,
    );
    const ambiguous = findAmbiguousStemSidecarDirs([photo]);
    const order = metadataSourcePathsInOrder(photo, ambiguous, stats);
    // All of the RAW's sources (sidecars + embedded) come before any of the JPEG's,
    // regardless of the JPEG sidecar being more recently modified.
    expect(order).toEqual([rawSidecar, stemSidecar, rawPath, jpegSidecar, jpegPath]);
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

  it('maps caption, copyright and IPTC keyword fallbacks from sidecar XMP', async () => {
    writeFileSync(join(root, 'meta.jpg'), 'fake');
    writeFileSync(
      join(root, 'meta.jpg.xmp'),
      xmp("dc:description='My caption' dc:rights='My copyright' dc:subject='alpha, beta'"),
    );
    const db = initLibraryDb(join(dir, 'library.db'));
    try {
      await syncFolderCatalog(root, db, {});
      const row = db.prepare('SELECT caption, copyright, keywords FROM images').get() as {
        caption: string;
        copyright: string;
        keywords: string;
      };
      expect(row.caption).toBe('My caption');
      expect(row.copyright).toBe('My copyright');
      expect(JSON.parse(row.keywords)).toEqual(['alpha', 'beta']);
    } finally {
      db.close();
    }
  });

  it('falls back to IPTC fields when XMP dc fields are absent', () => {
    const partial = partialFromTags({
      'Caption-Abstract': 'IPTC caption',
      Rights: 'IPTC rights',
      Keywords: 'kw1, kw2',
    } as import('exiftool-vendored').Tags);
    expect(partial.caption).toBe('IPTC caption');
    expect(partial.copyright).toBe('IPTC rights');
    expect(partial.keywords).toEqual(['kw1', 'kw2']);
  });

  it('clears caption and copyright when a re-sync finds the sidecar removed', async () => {
    writeFileSync(join(root, 'gone.jpg'), 'fake');
    writeFileSync(
      join(root, 'gone.jpg.xmp'),
      xmp("dc:description='Was here' dc:rights='Was mine'"),
    );
    const db = initLibraryDb(join(dir, 'library.db'));
    try {
      await syncFolderCatalog(root, db, {});
      rmSync(join(root, 'gone.jpg.xmp'));
      await syncFolderCatalog(root, db, {});
      const row = db.prepare('SELECT caption, copyright FROM images').get() as {
        caption: string;
        copyright: string;
      };
      expect(row.caption).toBe('');
      expect(row.copyright).toBe('');
    } finally {
      db.close();
    }
  });

  it('clears fields when a re-sync finds the sidecar value emptied', async () => {
    writeFileSync(join(root, 'empty.jpg'), 'fake');
    writeFileSync(join(root, 'empty.jpg.xmp'), xmp("dc:description='Hello'"));
    const db = initLibraryDb(join(dir, 'library.db'));
    try {
      await syncFolderCatalog(root, db, {});
      writeFileSync(join(root, 'empty.jpg.xmp'), xmp(''));
      utimesSync(join(root, 'empty.jpg.xmp'), new Date('2032-01-01T00:00:00Z'), new Date('2032-01-01T00:00:00Z'));
      await syncFolderCatalog(root, db, {});
      const row = db.prepare('SELECT caption FROM images').get() as { caption: string };
      expect(row.caption).toBe('');
    } finally {
      db.close();
    }
  });

  it('prefers sidecar XMP over embedded XMP and IPTC for the same field', async () => {
    writeFileSync(join(root, 'mix.jpg'), 'fake');
    writeFileSync(join(root, 'mix.jpg.xmp'), xmp("dc:title='from sidecar'"));
    const photo: ResolvedFolderPhoto = {
      filepath: join(root, 'mix.jpg'),
      relPath: 'mix.jpg',
      filename: 'mix',
      stem: 'mix',
    };
    const sidecar = join(root, 'mix.jpg.xmp');
    const session = {
      maxProcs: 1,
      ensureReady: async () => null,
      read: async (path: string) => {
        if (path === sidecar) return { Title: 'from sidecar' } as import('exiftool-vendored').Tags;
        return {
          Title: 'embedded title',
          'Caption-Abstract': 'iptc caption',
        } as import('exiftool-vendored').Tags;
      },
      readParallel: async () => new Map(),
      end: async () => {},
    };
    const meta = await readFolderPhotoXmpMetadata(
      session,
      photo,
      new Set(),
      await lstatPathsParallel([photo.filepath, sidecar], 2),
    );
    expect(meta.title).toBe('from sidecar');
    expect(meta.caption).toBe('iptc caption');
  });
});
