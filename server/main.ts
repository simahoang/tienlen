import { startServer } from './index';

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const rawPort = process.env['SERVER_PORT'] ?? process.env['PORT'] ?? '8787';
const parsedPort = Number.parseInt(rawPort, 10);
const port = Number.isInteger(parsedPort) && parsedPort >= 0 ? parsedPort : 8787;
const host = process.env['HOST'] ?? '127.0.0.1';
const roomTtlMs = positiveInt(process.env['ROOM_TTL_MS'], 600_000);
const maxRooms = positiveInt(process.env['MAX_ROOMS'], 500);

startServer({ port, host, roomTtlMs, maxRooms })
  .then((server) => {
    console.log(
      `[game2-server] listening http://${host}:${server.port} and ws://${host}:${server.port} (rules 1.3.0)`,
    );
    const shutdown = (): void => {
      server
        .close()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[game2-server] failed to start: ${message}`);
    process.exit(1);
  });
