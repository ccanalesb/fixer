/**
 * Server entrypoint.
 *
 * Binds 5001 by default (see config): macOS AirPlay Receiver owns :5000 and
 * answers requests there, which masquerades as a broken backend.
 *
 * This is where the side effects live — the socket server, the job processor and
 * the restart-recovery pass. `createApp()` stays pure so that the OpenAPI export
 * and the test suite can build the app without starting background work.
 */
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { Server as SocketIOServer } from 'socket.io';
import { config } from './config.js';
import { createApp } from './app.js';
import { upgradeLibraryDb } from './api/library-db.js';
import { initLibraryDb } from './db/library/bootstrap.js';
import { startJobProcessor, stopJobProcessor } from './jobs/processor.js';
import { registerSocketEvents, resetSocketServer } from './websocket/events.js';

/**
 * Exit rather than start a second backend on the same port.
 *
 * Two backends against one SQLite file produce write-lock contention and
 * intermittent 500s on cancel and retry. Refusing to start is a far clearer
 * failure than debugging that.
 */
async function refuseIfPortInUse(host: string, port: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const probe = createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        process.stderr.write(
          `Refusing to start: something is already listening on ${host}:${port}. ` +
            'Two backends sharing one SQLite file cause write-lock contention.\n',
        );
        process.exit(1);
      }
      resolve();
    });
    probe.once('listening', () => probe.close(() => resolve()));
    probe.listen(port, host);
  });
}

await refuseIfPortInUse(config.HOST, config.PORT);

const libraryDbPath = config.LIBRARY_DB;
if (process.env.LT_DATA_DIR && !existsSync(libraryDbPath)) {
  initLibraryDb(libraryDbPath).close();
}

// A library.db that cannot be upgraded still lets the server start; its requests answer 500 saying why.
try {
  upgradeLibraryDb(libraryDbPath);
} catch (e) {
  process.stderr.write(`library.db not upgraded: ${e instanceof Error ? e.message : String(e)}\n`);
}

const app = createApp();

const server = serve({ fetch: app.fetch, hostname: config.HOST, port: config.PORT }, (info) => {
  process.stderr.write(`backend listening on http://${config.HOST}:${info.port}\n`);
});

/**
 * SocketIO shares the HTTP server. Job progress is pushed over this channel —
 * the frontend must never poll for job status.
 */
export const io = new SocketIOServer(server as never, {
  cors: { origin: config.FRONTEND_ORIGINS, credentials: true },
});
registerSocketEvents(io);

// Registered after the socket server, so the recovery pass can broadcast the ids
// it re-queued to any client already connected.
startJobProcessor();

const shutdown = (signal: string) => {
  process.stderr.write(`\n${signal} received, shutting down\n`);
  stopJobProcessor();
  resetSocketServer();
  io.close();
  server.close(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
