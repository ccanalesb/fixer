/**
 * Explicit command registry for the CLI (ADR-0006).
 *
 * One list, greppable, no auto-discovery.
 */
import type { LibraryConfig } from '../config.js';
import type { FlagSpec, ParsedArgs } from './parse.js';
import { cmdScan, cmdSync } from './commands/catalog.js';
import { cmdCullCheck, cmdCullImport } from './commands/cull.js';
import { cmdEnrichCatalog } from './commands/enrich.js';
import { cmdInit } from './commands/init.js';
import { cmdExport, cmdSearch, cmdStats } from './commands/query.js';

export interface CommandContext {
  args: ParsedArgs;
  config: LibraryConfig;
  /** Injected so tests can read what a command printed without capturing stdout. */
  out: (line: string) => void;
}

/**
 * A command returns its process exit code: 0 for success, 1 for failure.
 *
 * `enrich-catalog` is async; `run` awaits either.
 */
export type CommandHandler = (ctx: CommandContext) => number | Promise<number>;

export interface CliCommand {
  name: string;
  help: string;
  flags: readonly FlagSpec[];
  handler: CommandHandler;
}

/** `--db`, which every command that touches the library declares. */
const DB_FLAG: FlagSpec = {
  name: 'db',
  kind: 'string',
  help: 'Path to SQLite database (overrides global)',
};

const CATALOG_FLAG: FlagSpec = {
  name: 'catalog',
  kind: 'string',
  help: 'Path to .lrcat file (overrides global)',
};

const LIMIT_FLAG: FlagSpec = { name: 'limit', kind: 'int', help: 'Limit results' };

export const COMMANDS: readonly CliCommand[] = [
  {
    name: 'scan',
    help: 'Scan catalog, index all images',
    flags: [
      CATALOG_FLAG,
      DB_FLAG,
      { name: 'workers', kind: 'int', help: 'Parallel workers (no effect)' },
      { name: 'limit', kind: 'int', help: 'Limit number of images to process' },
    ],
    handler: cmdScan,
  },
  {
    name: 'sync',
    help: 'Incremental catalog sync — add missing images to library.db',
    flags: [
      CATALOG_FLAG,
      DB_FLAG,
      {
        name: 'backfill-keywords',
        kind: 'boolean',
        help: 'Re-read keywords for rows already in library.db',
      },
    ],
    handler: cmdSync,
  },
  {
    name: 'search',
    help: 'Search indexed images',
    flags: [
      DB_FLAG,
      { name: 'keyword', kind: 'string', help: 'Search by keyword' },
      { name: 'rating', kind: 'int', help: 'Minimum rating (0-5)' },
      { name: 'color-label', kind: 'string', help: 'Filter by color label' },
      { name: 'date-start', kind: 'string', help: 'Start date (ISO format)' },
      { name: 'date-end', kind: 'string', help: 'End date (ISO format)' },
      LIMIT_FLAG,
    ],
    handler: cmdSearch,
  },
  {
    name: 'export',
    help: 'Export to JSON/CSV',
    flags: [
      DB_FLAG,
      { name: 'output', short: 'o', kind: 'string', help: 'Output file path', required: true },
      {
        name: 'format',
        kind: 'string',
        choices: ['json', 'csv'],
        help: 'Export format (default: json)',
      },
      { name: 'keyword', kind: 'string', help: 'Export only images matching keyword' },
      { name: 'rating', kind: 'int', help: 'Export only images with minimum rating' },
      LIMIT_FLAG,
    ],
    handler: cmdExport,
  },
  {
    name: 'init',
    help: 'Initialize database',
    flags: [DB_FLAG],
    handler: cmdInit,
  },
  {
    name: 'stats',
    help: 'Show database statistics',
    flags: [DB_FLAG],
    handler: cmdStats,
  },
  {
    name: 'enrich-catalog',
    help: 'Warm the vision cache for catalog images',
    flags: [
      DB_FLAG,
      { ...CATALOG_FLAG, help: 'Path to .lrcat file (no effect)' },
      { name: 'limit', kind: 'int', help: 'Limit number of images to process' },
      { name: 'cache-only', kind: 'boolean', help: 'Warm vision cache only (always on)' },
    ],
    handler: cmdEnrichCatalog,
  },
  {
    name: 'cull-check',
    help: "Check culling's stages: each endpoint and model from config.yaml, one test image",
    flags: [{ name: 'photo', kind: 'string', help: "Also answer this photo and print each stage's probabilities" }],
    handler: cmdCullCheck,
  },
  {
    name: 'cull-import',
    help: 'Import culling answers from JSONL files, one line per photo',
    flags: [
      DB_FLAG,
      { name: 'laya-new', kind: 'string', help: 'Score forecast answers (Laya new): key, image, rows of slug and probs' },
      { name: 'culling-profile', kind: 'string', help: 'Culling profile answers (Laya base): key, image, answers by <levels>|<dimension>' },
      { name: 'laya-new-model-id', kind: 'string', help: 'Name Laya new by hand instead of by its export' },
      { name: 'dry-run', kind: 'boolean', help: 'Report what would be imported, write nothing' },
    ],
    handler: cmdCullImport,
  },
];
