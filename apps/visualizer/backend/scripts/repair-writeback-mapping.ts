/**
 * One-off repair for write-backs that landed on the wrong catalog photo.
 *
 * Before the catalog was looked up by file id, an image key resolved by basename
 * alone, so the stars or reject meant for one photo went to whichever photo with
 * that name the catalog returned first. For every write-back state whose key now
 * resolves to a different photo this:
 *
 *   - gives the photo hit by mistake its value from `--backup` back and unlinks the
 *     auto keyword, unless that photo's own write-back holds the same value;
 *   - returns the state to `pending`, so the next write-back run writes the right
 *     photo. The own states of restored photos go back to `pending` too, since they
 *     were judged against the wrong value.
 *
 * A photo is only restored while it still holds a value we wrote by mistake;
 * anything changed since is reported and left alone.
 *
 * Dry run by default. `--apply` refuses while Lightroom holds the catalog and copies
 * the catalog and library aside first.
 *
 *   npx tsx scripts/repair-writeback-mapping.ts --backup <catalog backup> [--apply]
 *     [--catalog <lrcat>] [--library <library.db>]
 */
import { constants, copyFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { loadLibraryConfig } from '../src/config.js';
import { openLibraryDb } from '../src/db/connection.js';
import {
  AUTO_REJECT_KEYWORD,
  AUTO_STARS_KEYWORD,
  catalogBaseNameFromImageKey,
  connectCatalog,
  getImageLocalId,
  getKeywordId,
  raiseIfCatalogLocked,
} from '../src/lightroom/writer.js';
import { nowIsoUtc } from '../src/utils/datetime.js';

type Kind = 'stars' | 'reject';

interface StateRow {
  image_key: string;
  kind: Kind;
  status: 'written' | 'skipped';
  written_pick: number | null;
  written_rating: number | null;
  written_at: string | null;
}

type Outcome = 'restored' | 'kept_own_value' | 'changed_since';

const { values: args } = parseArgs({
  options: {
    backup: { type: 'string' },
    catalog: { type: 'string' },
    library: { type: 'string' },
    apply: { type: 'boolean', default: false },
  },
});

const cfg = loadLibraryConfig();
const catalogPath = args.catalog ?? cfg.catalogPath;
const libraryPath = args.library ?? cfg.dbPath;
if (!args.backup || !catalogPath || !libraryPath) {
  console.error('usage: repair-writeback-mapping.ts --backup <catalog backup> [--apply] [--catalog p] [--library p]');
  process.exit(2);
}
if (args.apply) raiseIfCatalogLocked(catalogPath);

const lib = openLibraryDb(libraryPath);
const cat = connectCatalog(catalogPath, lib);
const bak = new Database(args.backup, { readonly: true, fileMustExist: true });

const states = lib
  .prepare(
    `SELECT image_key, kind, status, written_pick, written_rating, written_at
     FROM lr_writeback_state WHERE status IN ('written', 'skipped')`,
  )
  .all() as StateRow[];

const firstWrite = states
  .map((s) => s.written_at)
  .filter((t): t is string => t !== null)
  .sort()[0];
if (firstWrite && statSync(args.backup).mtimeMs >= Date.parse(firstWrite)) {
  console.error(`${args.backup} is not older than the first write-back (${firstWrite}); it may hold our writes.`);
  process.exit(2);
}

// The lookup the write-backs ran with, to find the photo each one actually hit.
const basenameLookup = cat.prepare(
  `SELECT ai.id_local FROM AgLibraryFile f
   JOIN Adobe_images ai ON ai.rootFile = f.id_local
   WHERE f.baseName = ?`,
);
const hitBy = (key: string): number | null =>
  (basenameLookup.get(catalogBaseNameFromImageKey(key)) as { id_local: number } | undefined)?.id_local ?? null;

const field = (kind: Kind) => (kind === 'stars' ? 'rating' : 'pick');
const writtenValue = (s: StateRow) => (s.kind === 'stars' ? s.written_rating : s.written_pick);
const readField = (db: Database.Database, imageId: number, kind: Kind): number | null => {
  const row = db.prepare(`SELECT ${field(kind)} AS v FROM Adobe_images WHERE id_local = ?`).get(imageId) as
    | { v: number | null }
    | undefined;
  return row?.v ?? null;
};
const keywordName = (kind: Kind) => (kind === 'stars' ? AUTO_STARS_KEYWORD : AUTO_REJECT_KEYWORD);
const hasLink = (db: Database.Database, imageId: number, keywordId: number | null): boolean =>
  keywordId !== null &&
  db.prepare('SELECT 1 FROM AgLibraryKeywordImage WHERE image = ? AND tag = ?').get(imageId, keywordId) !== undefined;

const slot = (imageId: number, kind: Kind) => `${imageId}:${kind}`;
const ownStates = new Map<string, StateRow>();
const misdirected: StateRow[] = [];
const wrongValues = new Map<string, Set<number | null>>();
for (const s of states) {
  const target = getImageLocalId(cat, s.image_key);
  if (target !== null) ownStates.set(slot(target, s.kind), s);
  const hit = hitBy(s.image_key);
  if (hit === target) continue;
  misdirected.push(s);
  if (s.status === 'written' && hit !== null) {
    const values = wrongValues.get(slot(hit, s.kind)) ?? new Set();
    values.add(writtenValue(s));
    wrongValues.set(slot(hit, s.kind), values);
  }
}

interface Restore {
  imageId: number;
  kind: Kind;
  now: number | null;
  original: number | null;
  unlinkKeyword: boolean;
}
const outcomes = new Map<Outcome, { kind: Kind; imageId: number; now: number | null; original: number | null }[]>();
const restores: Restore[] = [];
const resets = new Map<string, StateRow>(misdirected.map((s) => [`${s.image_key}:${s.kind}`, s]));

for (const [key, values] of wrongValues) {
  const [id, kind] = key.split(':') as [string, Kind];
  const imageId = Number(id);
  const now = readField(cat, imageId, kind);
  const original = readField(bak, imageId, kind);
  const own = ownStates.get(key);
  let outcome: Outcome;
  if (own?.status === 'written' && writtenValue(own) === now) {
    outcome = 'kept_own_value';
  } else if (values.has(now)) {
    outcome = 'restored';
    const bakKeyword = getKeywordId(bak, keywordName(kind));
    restores.push({ imageId, kind, now, original, unlinkKeyword: !hasLink(bak, imageId, bakKeyword) });
    if (own) resets.set(`${own.image_key}:${own.kind}`, own);
  } else {
    outcome = 'changed_since';
  }
  const list = outcomes.get(outcome) ?? [];
  list.push({ kind, imageId, now, original });
  outcomes.set(outcome, list);
}

const tally = <T extends { kind: Kind }>(rows: T[]) =>
  `${rows.filter((r) => r.kind === 'stars').length} stars, ${rows.filter((r) => r.kind === 'reject').length} reject`;
console.log(`states resolving to a different photo: ${tally(misdirected)}`);
console.log(`  written: ${tally(misdirected.filter((s) => s.status === 'written'))}`);
console.log(`  skipped: ${tally(misdirected.filter((s) => s.status === 'skipped'))}`);
console.log(`photos hit by mistake: ${wrongValues.size}`);
for (const outcome of ['restored', 'kept_own_value', 'changed_since'] as const) {
  const rows = outcomes.get(outcome) ?? [];
  console.log(`  ${outcome}: ${tally(rows)}`);
  for (const r of rows.slice(0, 5)) {
    console.log(`    image ${r.imageId} ${field(r.kind)} now=${r.now} original=${r.original}`);
  }
}
console.log(`  keyword unlinks: ${restores.filter((r) => r.unlinkKeyword).length}`);
console.log(`states back to pending: ${tally([...resets.values()])}`);

if (!args.apply) {
  console.log('\ndry run: nothing written. Re-run with --apply to repair.');
  process.exit(0);
}

const d = new Date();
const pad = (n: number) => String(n).padStart(2, '0');
const ts =
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
  `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
const catalogCopy = `${catalogPath}.pre-mapping-repair-${ts}`;
copyFileSync(catalogPath, catalogCopy, constants.COPYFILE_FICLONE);
const libraryCopy = `${libraryPath}.pre-mapping-repair-${ts}.bak`;
await lib.backup(libraryCopy);
console.log(`\nbacked up to ${catalogCopy}\n         and ${libraryCopy}`);

const keywordIds = { stars: getKeywordId(cat, AUTO_STARS_KEYWORD), reject: getKeywordId(cat, AUTO_REJECT_KEYWORD) };
let restored = 0;
cat.transaction(() => {
  for (const r of restores) {
    const info = cat
      .prepare(`UPDATE Adobe_images SET ${field(r.kind)} = ? WHERE id_local = ? AND ${field(r.kind)} IS ?`)
      .run(r.original, r.imageId, r.now);
    if (info.changes === 0) throw new Error(`image ${r.imageId} changed during the repair`);
    restored += 1;
    if (r.unlinkKeyword && keywordIds[r.kind] !== null) {
      cat.prepare('DELETE FROM AgLibraryKeywordImage WHERE image = ? AND tag = ?').run(r.imageId, keywordIds[r.kind]);
    }
  }
})();

const updatedAt = nowIsoUtc();
const reset = lib.prepare(
  `UPDATE lr_writeback_state
   SET status = 'pending', before_pick = NULL, before_rating = NULL,
       written_pick = NULL, written_rating = NULL, written_at = NULL, updated_at = ?
   WHERE image_key = ? AND kind = ?`,
);
lib.transaction(() => {
  for (const s of resets.values()) reset.run(updatedAt, s.image_key, s.kind);
})();

console.log(`restored ${restored} photos, ${resets.size} states back to pending`);
cat.close();
lib.close();
bak.close();
