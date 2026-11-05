import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { rules } from '../src/data/index';
import type { Card } from '../src/rules/types';
import { loadAuthConfig, type AuthConfig } from './auth/config';
import { createHttpHandler } from './auth/http';
import type { AuthedSocket, Principal } from './auth/principal';
import { SESSION_COOKIE_NAME, readCookie, readSession } from './auth/session';
import { GameStore, type StoreLogger } from './db';
import { RoomManager, type RoomManagerConfig } from './rooms';

export interface StartServerOptions {
  /** 0 = OS chọn cổng ngẫu nhiên (dùng cho test). */
  readonly port?: number;
  readonly host?: string;
  /** Override cho test: thời gian/lượt, window, disconnect, reconnect, rate limit. */
  readonly turnMs?: number;
  readonly windowMs?: number;
  readonly disconnectMs?: number;
  readonly reconnectMs?: number;
  readonly rateMax?: number;
  readonly rateWindowMs?: number;
  /** TTL dọn phòng finished khi hết người kết nối (ms), mặc định 600000. */
  readonly roomTtlMs?: number;
  /** Hiện bảng điểm ván trước khi auto chia ván mới (ms), mặc định rules.tour.resultDisplayMs. */
  readonly tourResultDisplayMs?: number;
  /** Đếm ngược resume tour từ TAM_DUNG (ms), mặc định rules.tour.resumeCountdownMs. */
  readonly tourResumeMs?: number;
  /** Số người tối thiểu để chia ván, mặc định rules.tour.minPlayersToStart. */
  readonly minPlayersToStart?: number;
  /** Giới hạn phòng đồng thời, mặc định 500. */
  readonly maxRooms?: number;
  /** Hook test: seed cố định và/hoặc chia tay thủ công. */
  readonly seed?: number;
  readonly hands?: readonly (readonly Card[])[];
  readonly startingPlayerIndex?: number;
  /** Đường dẫn SQLite; mặc định env `DB_PATH` hoặc `data/game2.sqlite`. */
  readonly dbPath?: string;
  /** Inject store (test) — server không đóng store do caller quản lý. */
  readonly store?: GameStore;
  /** Logger cho cảnh báo DB. */
  readonly logger?: StoreLogger;
  /** Inject cấu hình auth (test); mặc định đọc env và fail-fast nếu thiếu. */
  readonly auth?: AuthConfig;
  /** Thư mục build client để phục vụ static; mặc định `<cwd>/dist`. */
  readonly distDir?: string;
}

export interface RunningServer {
  readonly port: number;
  readonly wss: WebSocketServer;
  readonly rooms: RoomManager;
  /** Cấu hình auth đang dùng (test mint cookie phiên bằng `issueSession`). */
  readonly auth: AuthConfig;
  close(): Promise<void>;
}

function rejectUpgrade(socket: Duplex, status: string): void {
  try {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    // socket đã đóng giữa chừng — không cần xử lý thêm.
  }
  socket.destroy();
}

/** Không có ALLOWED_ORIGINS: chỉ chấp nhận origin cùng host với request. */
export function isAllowedOrigin(
  origin: string | undefined,
  host: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (origin === undefined || origin.length === 0) return true;
  if (allowedOrigins.length > 0) return allowedOrigins.includes(origin);
  if (host === undefined || host.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return parsed.host.toLowerCase() === host.toLowerCase();
}

export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const auth = options.auth ?? loadAuthConfig(process.env);
  const ownsStore = options.store === undefined;
  const store =
    options.store ??
    new GameStore(
      options.dbPath ?? process.env['DB_PATH'] ?? 'data/game2.sqlite',
      options.logger,
    );
  const config: RoomManagerConfig = {
    turnMs: options.turnMs ?? rules.turn.turnTimerMs,
    windowMs: options.windowMs ?? rules.chatNgoaiLuot.windowMs,
    disconnectMs: options.disconnectMs ?? 10000,
    reconnectMs: options.reconnectMs ?? 180000,
    rateMax: options.rateMax ?? 5,
    rateWindowMs: options.rateWindowMs ?? 1000,
    roomTtlMs: options.roomTtlMs ?? 600000,
    maxRooms: options.maxRooms ?? 500,
    ...(options.tourResultDisplayMs === undefined
      ? {}
      : { tourResultDisplayMs: options.tourResultDisplayMs }),
    ...(options.tourResumeMs === undefined ? {} : { tourResumeMs: options.tourResumeMs }),
    ...(options.minPlayersToStart === undefined
      ? {}
      : { minPlayersToStart: options.minPlayersToStart }),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.hands ? { hands: options.hands } : {}),
    ...(options.startingPlayerIndex === undefined
      ? {}
      : { startingPlayerIndex: options.startingPlayerIndex }),
    store,
  };
  const rooms = new RoomManager(config);
  const handler = createHttpHandler(
    auth,
    options.distDir === undefined ? {} : { distDir: options.distDir },
  );
  const httpServer: Server = createServer(handler);
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!isAllowedOrigin(req.headers.origin, req.headers.host, auth.allowedOrigins)) {
      rejectUpgrade(socket, '403 Forbidden');
      return;
    }
    const raw = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
    const principal: Principal | null = readSession(raw, auth.sessionSecret);
    if (principal === null) {
      rejectUpgrade(socket, '401 Unauthorized');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      (ws as AuthedSocket).principal = principal;
      rooms.handleConnection(ws);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      httpServer.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      httpServer.off('error', onError);
      resolve();
    };
    httpServer.once('listening', onListening);
    httpServer.once('error', onError);
    httpServer.listen(options.port ?? 0, options.host ?? '127.0.0.1');
  });

  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    rooms.dispose();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    throw new Error('không lấy được cổng HTTP');
  }

  let closed = false;
  return {
    port: address.port,
    wss,
    rooms,
    auth,
    close: async () => {
      if (closed) return;
      closed = true;
      rooms.dispose();
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      });
      if (ownsStore) store.close();
    },
  };
}
