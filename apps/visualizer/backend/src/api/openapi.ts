/**
 * OpenAPI configuration.
 *
 * ADR-0013 makes the backend authoritative for API shape: Zod schemas here are the
 * single source of truth, the OpenAPI document is generated from them, and the
 * frontend's `src/types/api.gen.ts` is generated from that document with CI failing
 * on drift.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Env } from 'hono';

export const OPENAPI_TITLE = 'Fixer API';
export const OPENAPI_VERSION = '1.0.0';

/**
 * Build the OpenAPI-aware Hono app.
 *
 * Request-validation failures return **422** with `{ loc, msg, type }[]`. Routes that
 * previously swallowed validation errors inside a DB wrapper now surface 422.
 */
export function createOpenApiApp<E extends Env = Env>(): OpenAPIHono<E> {
  return new OpenAPIHono<E>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const issues = result.error.issues.map((issue) => ({
          loc: issue.path.map(String),
          msg: issue.message,
          type: issue.code,
        }));
        return c.json(issues, 422);
      }
      return undefined;
    },
  });
}

export interface OpenApiDocOptions {
  servers?: { url: string; description?: string }[];
}

/** The document descriptor handed to `app.doc()`. */
export function openApiDoc(opts: OpenApiDocOptions = {}) {
  return {
    openapi: '3.1.0',
    info: { title: OPENAPI_TITLE, version: OPENAPI_VERSION },
    ...(opts.servers ? { servers: opts.servers } : {}),
  } as const;
}
