/**
 * Library-DB path resolution and connection lifecycle for the CLI.
 */
import { existsSync } from 'node:fs';
import { openLibraryDb, type Db } from '../db/connection.js';
import { initLibraryDb, upgradeLibrarySchema } from '../db/library/bootstrap.js';
import { resolveCliLibrary } from './library-resolution.js';
import type { CommandContext } from './registry.js';
import { stringFlag } from './parse.js';

const MISSING_DB_PATH_MSG = 'No database path provided. Use --db or config.yaml';

/** A failure the user can read and act on; printed without a stack trace. */
export class CliError extends Error {}

export interface WithLibraryDbOpts {
  mustExist: boolean;
  /** Only `scan` / `sync` without `--catalog` may create a library for `config.yaml`'s catalog. */
  allowCreateLibrary?: boolean;
}

/** `--db` if given, else the library the catalog lookup finds. */
export function resolveLibraryDbPath(ctx: CommandContext, opts: WithLibraryDbOpts): string {
  const { paths } = resolveCliLibrary(ctx, opts.allowCreateLibrary ?? false);
  const dbPath = paths.libraryDbPath;
  if (!dbPath) throw new CliError(MISSING_DB_PATH_MSG);
  if (opts.mustExist && !existsSync(dbPath)) {
    throw new CliError(`Database not found: ${dbPath}`);
  }
  return dbPath;
}

/** Open for a command. An existing database is brought up to the current schema. */
function openForCommand(dbPath: string, mustExist: boolean): Db {
  if (!mustExist && !existsSync(dbPath)) return initLibraryDb(dbPath);
  if (!mustExist && existsSync(dbPath)) {
    const db = openLibraryDb(dbPath);
    try {
      upgradeLibrarySchema(db);
    } catch (e) {
      db.close();
      throw e;
    }
    return db;
  }
  const db = openLibraryDb(dbPath);
  try {
    upgradeLibrarySchema(db);
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

/**
 * Run `body` against an open library DB, closing it whatever happens.
 *
 * `mustExist: false` bootstraps the schema when the path is missing (`scan`, `sync`).
 */
export function withLibraryDb<T>(
  ctx: CommandContext,
  opts: WithLibraryDbOpts,
  body: (db: Db, dbPath: string) => T,
): T {
  const dbPath = resolveLibraryDbPath(ctx, opts);
  const db = openForCommand(dbPath, opts.mustExist);
  try {
    return body(db, dbPath);
  } finally {
    db.close();
  }
}

export async function withLibraryDbAsync<T>(
  ctx: CommandContext,
  opts: WithLibraryDbOpts,
  body: (db: Db, dbPath: string) => Promise<T>,
): Promise<T> {
  const dbPath = resolveLibraryDbPath(ctx, opts);
  const db = openForCommand(dbPath, opts.mustExist);
  try {
    return await body(db, dbPath);
  } finally {
    db.close();
  }
}

/** Whether the CLI pinned a library with `--db`. */
export function cliLibraryPinned(ctx: CommandContext): boolean {
  return stringFlag(ctx.args, 'db') != null;
}
