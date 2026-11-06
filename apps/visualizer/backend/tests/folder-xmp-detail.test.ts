import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initLibraryDb, setLibraryMeta } from '../src/db/library/bootstrap.js';
import { CATALOG_KIND_META_KEY, CATALOG_PATH_META_KEY } from '../src/catalog-library.js';
import { buildFolderXmpDetail } from '../src/folder/xmp-detail.js';
import { syncFolderCatalog } from '../src/folder/sync.js';

const xmp = (body: string) =>
  `<?xml version='1.0'?><x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#' xmlns:xmp='http://ns.adobe.com/xap/1.0/' xmlns:dc='http://purl.org/dc/elements/1.1/'><rdf:Description rdf:about='' ${body}/></rdf:RDF></x:xmpmeta>`;

let dir: string;
let root: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-xmp-detail-'));
  root = join(dir, 'photos');
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('folder XMP detail for the image modal', () => {
  it('returns null for a Lightroom catalog library', async () => {
    const db = initLibraryDb(join(dir, 'library.db'));
    try {
      setLibraryMeta(db, CATALOG_KIND_META_KEY, 'lightroom');
      expect(await buildFolderXmpDetail(db, 'any')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('labels each field with the sidecar or embedded source', async () => {
    writeFileSync(join(root, 'one.jpg'), 'jpg');
    writeFileSync(
      join(root, 'one.jpg.xmp'),
      xmp("xmp:Rating='4' xmp:Label='Red' dc:subject='beach' dc:title='Title here'"),
    );
    const db = initLibraryDb(join(dir, 'library.db'));
    try {
      setLibraryMeta(db, CATALOG_KIND_META_KEY, 'folder');
      setLibraryMeta(db, CATALOG_PATH_META_KEY, root);
      await syncFolderCatalog(root, db, {});
      const key = (db.prepare('SELECT key FROM images').get() as { key: string }).key;
      const detail = await buildFolderXmpDetail(db, key);
      expect(detail?.file_missing).toBe(false);
      expect(detail?.rating.display).toBe('4★');
      expect(detail?.rating.source).toBe('sidecar one.jpg.xmp');
      expect(detail?.label.value).toBe('Red');
      expect(detail?.label.source).toBe('sidecar one.jpg.xmp');
      expect(detail?.keywords.values).toEqual(['beach']);
      expect(detail?.title.value).toBe('Title here');
      expect(detail?.no_metadata_hint).toBe(false);
    } finally {
      db.close();
    }
  });

  it('lists sidecar read order when a stem sidecar is older than the extension sidecar', async () => {
    writeFileSync(join(root, 'pick.jpg'), 'jpg');
    const extSidecar = join(root, 'pick.jpg.xmp');
    const stemSidecar = join(root, 'pick.xmp');
    writeFileSync(extSidecar, xmp("xmp:Rating='5'"));
    writeFileSync(stemSidecar, xmp("xmp:Rating='1'"));
    utimesSync(extSidecar, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    utimesSync(stemSidecar, new Date('2025-01-01T00:00:00Z'), new Date('2025-01-01T00:00:00Z'));

    const db = initLibraryDb(join(dir, 'library.db'));
    try {
      setLibraryMeta(db, CATALOG_KIND_META_KEY, 'folder');
      setLibraryMeta(db, CATALOG_PATH_META_KEY, root);
      await syncFolderCatalog(root, db, {});
      const key = (db.prepare('SELECT key FROM images').get() as { key: string }).key;
      const detail = await buildFolderXmpDetail(db, key);
      expect(detail?.rating.source).toBe('sidecar pick.xmp');
      expect(detail?.sidecar_order.map((s) => s.basename)).toEqual(['pick.xmp', 'pick.jpg.xmp']);
      expect(detail?.secondary_sidecar_note).toEqual({
        basename: 'pick.jpg.xmp',
        read_after_basename: 'pick.xmp',
      });
    } finally {
      db.close();
    }
  });

  it('sets no_metadata_hint when nothing on disk carries XMP or IPTC', async () => {
    writeFileSync(join(root, 'plain.jpg'), 'jpg');
    const db = initLibraryDb(join(dir, 'library.db'));
    try {
      setLibraryMeta(db, CATALOG_KIND_META_KEY, 'folder');
      setLibraryMeta(db, CATALOG_PATH_META_KEY, root);
      await syncFolderCatalog(root, db, {});
      const key = (db.prepare('SELECT key FROM images').get() as { key: string }).key;
      const detail = await buildFolderXmpDetail(db, key);
      expect(detail?.no_metadata_hint).toBe(true);
      expect(detail?.sidecar_order).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('reports file_missing when the photo file is gone', async () => {
    writeFileSync(join(root, 'gone.jpg'), 'jpg');
    const db = initLibraryDb(join(dir, 'library.db'));
    try {
      setLibraryMeta(db, CATALOG_KIND_META_KEY, 'folder');
      setLibraryMeta(db, CATALOG_PATH_META_KEY, root);
      await syncFolderCatalog(root, db, {});
      const key = (db.prepare('SELECT key FROM images').get() as { key: string }).key;
      rmSync(join(root, 'gone.jpg'));
      const detail = await buildFolderXmpDetail(db, key);
      expect(detail?.file_missing).toBe(true);
    } finally {
      db.close();
    }
  });
});
