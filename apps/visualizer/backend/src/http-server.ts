import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';

export interface ServeAppOptions {
  fetch: (request: Request) => Response | Promise<Response>;
  hostname: string;
  port: number;
  onListening?: (info: AddressInfo) => void;
}

/**
 * Start the HTTP server without replacing the global `Request` and `Response`.
 *
 * transformers.js writes a Hub download to its file cache only when the `fetch`
 * response is `instanceof Response`; with Hono's replacements installed it is not,
 * nothing is cached, and loading the CLIP model fails on a fresh install.
 */
export function serveApp({ fetch, hostname, port, onListening }: ServeAppOptions): ServerType {
  return serve({ fetch, hostname, port, overrideGlobalObjects: false }, onListening);
}
