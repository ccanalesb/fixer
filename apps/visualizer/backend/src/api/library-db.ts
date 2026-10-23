/**
 * Library-DB access for routes.
 *
 * Implemented as Hono middleware rather than a handler wrapper. A wrapper that
 * returns responses on the handler's behalf erases the typed-response information
 * `@hono/zod-openapi` needs, so the route's declared shapes stop being checked
 * against what it actually returns. Middleware owns the 404/500 paths and hands
 * the handler an open connection. A missing database is a 404 with the canonical
 * message; any other failure is a 500 carrying the error text.
 *
 * An older `library.db` is upgraded to the current schema when the server starts and, should it be
 * replaced while running, by the first request that opens it.
 */
import type { Env, MiddlewareHandler } from 'hono';
import { existsSync } from 'node:fs';
import { config } from '../config.js';
import { ERROR_DB_NOT_FOUND } from '../constants/errors.js';
import { openLibraryDb, type Db } from '../db/connection.js';
import { libraryNeedsUpgrade, upgradeLibrarySchema } from '../db/library/bootstrap.js';

/** Bring an existing `library.db` up to the current schema. A missing one is left missing. */
export function upgradeLibraryDb(dbPath: string): void {
  if (!existsSync(dbPath)) return;
  const db = openLibraryDb(dbPath);
  try {
    upgradeLibrarySchema(db);
  } finally {
    db.close();
  }
}

/** Open for a request, upgrading first when the schema is older. */
function openForRequest(dbPath: string, readonly: boolean): Db {
  const db = openLibraryDb(dbPath, { readonly });
  if (!libraryNeedsUpgrade(db)) return db;
  db.close();
  upgradeLibraryDb(dbPath);
  return openLibraryDb(dbPath, { readonly });
}

/** Env for route groups that read `library.db`. */
export interface LibraryEnv extends Env {
  Variables: { libraryDb: Db };
}

export interface LibraryDbOptions {
  /** 404 when `library.db` is absent. */
  requireExists?: boolean;
  /**
   * Open writable. Only for groups that actually mutate.
   *
   * Read-only is not merely hygiene: it keeps GETs off the write lock the job
   * processor holds during a catalog sync, and turns an accidental write into a
   * loud failure rather than a corrupted `library.db`.
   */
  write?: boolean;
  /**
   * Open writable only for these HTTP methods, read-only for the rest.
   *
   * Needed by groups that mix reads and writes under one path prefix — the images
   * groups serve `GET /images/catalog/{key}` and `PATCH
   * /images/catalog/{key}/instagram-posted` from the same tree. Registering two
   * `use()` middlewares cannot express that: `app.route()` flattens a child's
   * middleware into the parent, so a second registration would also run for
   * sibling groups and open a redundant connection.
   */
  writeForMethods?: readonly string[];
}

/**
 * Open `library.db` for the request, expose it as `c.get('libraryDb')`, and close
 * it when the handler finishes.
 */
export function libraryDb(opts: LibraryDbOptions = {}): MiddlewareHandler<LibraryEnv> {
  return async (c, next) => {
    const dbPath = config.LIBRARY_DB;

    if (opts.requireExists !== false && !existsSync(dbPath)) {
      return c.json({ error: ERROR_DB_NOT_FOUND }, 404);
    }

    const write =
      opts.write ??
      (opts.writeForMethods?.includes(c.req.method.toUpperCase()) || false);

    let db: Db | undefined;
    try {
      db = openForRequest(dbPath, !write);
      c.set('libraryDb', db);
      await next();
      return;
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    } finally {
      db?.close();
    }
  };
}
