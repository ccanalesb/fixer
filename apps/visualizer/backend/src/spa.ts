/**
 * Packaged SPA static files under `<resources>/frontend` (built Vite `dist`).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Env } from 'hono';
import { resourcesRoot } from './config.js';

export function packagedFrontendRoot(): string | null {
  if (!process.env.LT_RESOURCES_DIR) return null;
  const root = join(resourcesRoot(), 'frontend');
  return existsSync(join(root, 'index.html')) ? root : null;
}

function isBackendPath(path: string): boolean {
  return (
    path.startsWith('/api') ||
    path.startsWith('/socket.io') ||
    path.startsWith('/apidoc') ||
    path.startsWith('/v1')
  );
}

/**
 * index.html names the hashed bundles of the installed version, so the webview must revalidate it
 * on every load; otherwise an upgraded app keeps running the previous version's frontend.
 * Set before serving: serveStatic builds its response before calling `onFound`.
 */
const REVALIDATE = 'no-cache';
const HASHED_BUNDLE = 'public, max-age=31536000, immutable';

/** History fallback for non-API paths when the packaged frontend is present. */
export function registerPackagedSpa<E extends Env>(app: OpenAPIHono<E>): void {
  const root = packagedFrontendRoot();
  if (!root) return;

  app.use('*', async (c, next) => {
    if (isBackendPath(c.req.path)) return next();
    c.header('Cache-Control', c.req.path.startsWith('/assets/') ? HASHED_BUNDLE : REVALIDATE);
    return serveStatic({ root })(c, next);
  });

  app.get('*', async (c, next) => {
    if (isBackendPath(c.req.path)) return next();
    c.header('Cache-Control', REVALIDATE);
    return serveStatic({ root, path: 'index.html' })(c, next);
  });
}
