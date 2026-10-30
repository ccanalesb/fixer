import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerType } from '@hono/node-server';
import { serveApp } from '../src/http-server.js';

describe('serveApp', () => {
  let server: ServerType | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  it('leaves fetch responses instances of the global Response', async () => {
    const port = await new Promise<number>((resolve) => {
      server = serveApp({
        fetch: () => new Response('ok'),
        hostname: '127.0.0.1',
        port: 0,
        onListening: (info: AddressInfo) => resolve(info.port),
      });
    });

    const res = await fetch(`http://127.0.0.1:${port}/`);

    expect(res).toBeInstanceOf(Response);
    expect(await res.text()).toBe('ok');
  });
});
