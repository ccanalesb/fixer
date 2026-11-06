/**
 * Folder catalog: XMP metadata in library.db drives catalog list filters.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { createApp } from '../src/app.js';
import { initLibraryDb, setLibraryMeta } from '../src/db/library/bootstrap.js';
import { CATALOG_KIND_META_KEY, CATALOG_PATH_META_KEY } from '../src/catalog-library.js';
import { syncFolderCatalog } from '../src/folder/sync.js';

const app = createApp();
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

const xmp = (body: string) =>
  `<?xml version='1.0'?><x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#' xmlns:xmp='http://ns.adobe.com/xap/1.0/' xmlns:dc='http://purl.org/dc/elements/1.1/'><rdf:Description rdf:about='' ${body}/></rdf:RDF></x:xmpmeta>`;

let dir: string;
let root: string;
let dbPath: string;
let cfgPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-folder-cat-api-'));
  root = join(dir, 'photos');
  mkdirSync(root, { recursive: true });
  dbPath = join(dir, 'library.db');
  cfgPath = join(dir, 'config.yaml');
  writeFileSync(cfgPath, stringifyYaml({ catalog_path: root }));
  process.env.LT_CONFIG_YAML = cfgPath;
  process.env.LIBRARY_DB = dbPath;

  writeFileSync(join(root, 'star.jpg'), 'fake');
  writeFileSync(join(root, 'star.jpg.xmp'), xmp("xmp:Rating='3' xmp:Label='Red' dc:subject='neon, city'"));
  writeFileSync(join(root, 'plain.jpg'), 'fake2');
  writeFileSync(join(root, 'plain.jpg.xmp'), xmp("xmp:Label='blue'"));

  const db = initLibraryDb(dbPath);
  setLibraryMeta(db, CATALOG_KIND_META_KEY, 'folder');
  setLibraryMeta(db, CATALOG_PATH_META_KEY, root);
  db.close();
});

afterEach(async () => {
  delete process.env.LIBRARY_DB;
  delete process.env.LT_CONFIG_YAML;
  rmSync(dir, { recursive: true, force: true });
});

describe('folder catalog list filters after sync', () => {
  it('returns photos matching min_rating, color_label and keyword filters', async () => {
    const db = initLibraryDb(dbPath);
    try {
      await syncFolderCatalog(root, db, {});
    } finally {
      db.close();
    }

    interface ListBody {
      total: number;
      images: { key: string }[];
    }

    const rated = await json<ListBody>(await app.request('/api/images/catalog?min_rating=3'));
    expect(rated.images.map((i) => i.key)).toEqual([expect.stringMatching(/star/)]);

    const red = await json<ListBody>(await app.request('/api/images/catalog?color_label=red'));
    expect(red.images.map((i) => i.key)).toEqual([expect.stringMatching(/star/)]);

    const neon = await json<ListBody>(await app.request('/api/images/catalog?keyword=neon'));
    expect(neon.images.map((i) => i.key)).toEqual([expect.stringMatching(/star/)]);
  });

  it('sends pick as -1 for a reject, 0 otherwise, on the list and the detail', async () => {
    writeFileSync(join(root, 'nope.jpg'), 'fake3');
    writeFileSync(join(root, 'nope.jpg.xmp'), xmp("xmp:Rating='-1'"));
    const db = initLibraryDb(dbPath);
    try {
      await syncFolderCatalog(root, db, {});
    } finally {
      db.close();
    }

    const list = await json<{ images: { key: string; pick: number }[] }>(
      await app.request('/api/images/catalog'),
    );
    const byName = Object.fromEntries(list.images.map((i) => [i.key.split('/').pop() ?? i.key, i.pick]));
    const rejectKey = list.images.find((i) => i.key.includes('nope'))!.key;
    expect(list.images.find((i) => i.key.includes('nope'))!.pick).toBe(-1);
    expect(list.images.find((i) => i.key.includes('plain'))!.pick).toBe(0);
    expect(Object.keys(byName).length).toBe(3);

    const detail = await json<{ pick: number }>(
      await app.request(`/api/images/catalog/${encodeURIComponent(rejectKey)}`),
    );
    expect(detail.pick).toBe(-1);
  });
});
