/**
 * Graceful shutdown wiring for the server entrypoint (SIGTERM, SIGINT, stdin EOF).
 */
import type { Server as HttpServer } from 'node:http';
import type { Server as SocketIOServer } from 'socket.io';
import { stopRunningConversions } from '../jobs/handlers/app-model-install.js';
import { stopJobProcessor } from '../jobs/processor.js';
import { resetSocketServer } from '../websocket/events.js';

export interface ShutdownDeps {
  io: SocketIOServer;
  server: HttpServer;
  onSignal?: (signal: string) => void;
}

export function runGracefulShutdown(deps: ShutdownDeps, signal: string): void {
  deps.onSignal?.(signal);
  stopJobProcessor();
  stopRunningConversions();
  resetSocketServer();
  deps.io.close();
  deps.server.close(() => process.exit(0));
}

export function registerGracefulShutdown(deps: ShutdownDeps): void {
  const shutdown = (signal: string) => runGracefulShutdown(deps, signal);
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  if (process.env.LT_EXIT_ON_STDIN_EOF === '1') {
    process.stdin.on('end', () => shutdown('STDIN_EOF'));
    process.stdin.resume();
  }
}
