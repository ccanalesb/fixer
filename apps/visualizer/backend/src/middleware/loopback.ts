/**
 * Loopback hardening for the packaged sidecar (ADR-0019): only local Host values and
 * known Origins on mutating requests. Missing Host or Origin is allowed so unit tests
 * and same-machine clients without those headers keep working.
 */
import type { Context, MiddlewareHandler, Next } from 'hono';
import { config } from '../config.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin;
  }
}

/** Backend and dev frontend origins allowed on mutating requests and socket handshakes. */
export function allowedOrigins(port: number): Set<string> {
  const origins = [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    ...config.FRONTEND_ORIGINS,
  ];
  return new Set(origins.map(normalizeOrigin));
}

export function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return true;
  const host = hostHeader.toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function isAllowedOrigin(originHeader: string | undefined, port: number): boolean {
  if (!originHeader) return true;
  return allowedOrigins(port).has(normalizeOrigin(originHeader));
}

/** Reject foreign Host; reject mutating requests with a foreign Origin when Origin is sent. */
export function loopbackMiddleware(port: number): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!isAllowedHost(c.req.header('host'), port)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (MUTATING.has(c.req.method) && !isAllowedOrigin(c.req.header('origin'), port)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    await next();
  };
}

/** Socket.IO engine middleware — same Host rule; Origin checked when present. */
export function assertLoopbackSocketHandshake(
  headers: { host?: string; origin?: string },
  port: number,
): boolean {
  if (!isAllowedHost(headers.host, port)) return false;
  if (!isAllowedOrigin(headers.origin, port)) return false;
  return true;
}
