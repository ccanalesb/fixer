/**
 * Spike-only server entry: real backend + production SPA static files on loopback.
 */
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Server as SocketIOServer } from 'socket.io';
import { config } from './dist/src/config.js';
import { createApp } from './dist/src/app.js';
import { upgradeLibraryDb } from './dist/src/api/library-db.js';
import { startJobProcessor, stopJobProcessor } from './dist/src/jobs/processor.js';
import { registerSocketEvents, resetSocketServer } from './dist/src/websocket/events.js';

async function refuseIfPortInUse(host, port) {
  await new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        process.stderr.write(
          `Refusing to start: something is already listening on ${host}:${port}.\n`,
        );
        process.exit(1);
      }
      resolve();
    });
    probe.once('listening', () => probe.close(() => resolve()));
    probe.listen(port, host);
  });
}

const frontendRoot = process.env.SPIKE_FRONTEND_DIST?.trim();
if (!frontendRoot) {
  process.stderr.write('SPIKE_FRONTEND_DIST is required\n');
  process.exit(1);
}

await refuseIfPortInUse(config.HOST, config.PORT);

try {
  upgradeLibraryDb(config.LIBRARY_DB);
} catch (e) {
  process.stderr.write(`library.db not upgraded: ${e instanceof Error ? e.message : String(e)}\n`);
}

const app = createApp();

app.use('/assets/*', serveStatic({ root: join(frontendRoot, 'assets') }));

app.get('/', (c) => c.html(readFileSync(join(frontendRoot, 'index.html'), 'utf8')));

app.get('*', (c) => {
  const p = c.req.path;
  if (
    p.startsWith('/api') ||
    p.startsWith('/v1') ||
    p.startsWith('/apidoc') ||
    p.startsWith('/socket.io')
  ) {
    return c.notFound();
  }
  return c.html(readFileSync(join(frontendRoot, 'index.html'), 'utf8'));
});

const server = serve({ fetch: app.fetch, hostname: config.HOST, port: config.PORT }, (info) => {
  process.stderr.write(
    `backend+spa listening on http://${config.HOST}:${info.port} (static ${frontendRoot})\n`,
  );
});

const io = new SocketIOServer(server, {
  cors: { origin: config.FRONTEND_ORIGINS, credentials: true },
});
registerSocketEvents(io);
startJobProcessor();

const shutdown = (signal) => {
  process.stderr.write(`\n${signal} received, shutting down\n`);
  stopJobProcessor();
  resetSocketServer();
  io.close();
  server.close(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
