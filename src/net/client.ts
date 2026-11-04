import type {
  ActionLogView,
  CardView,
  ClientMessage,
  PublicGameState,
  RoomView,
  ServerMessage,
} from './protocol';

/**
 * WS client tối giản cho M1: giữ snapshot state, phát cho subscriber,
 * tự nối lại bằng token `room.you.token` khi mất kết nối (tối đa 3 phút).
 */

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ClientError {
  readonly code: string;
  readonly message: string;
}

export interface ClientSnapshot {
  readonly status: ConnectionStatus;
  readonly room: RoomView | null;
  readonly state: PublicGameState | null;
  readonly stateReceivedAt: number;
  readonly hand: readonly CardView[];
  readonly actionLog: readonly ActionLogView[];
  readonly error: ClientError | null;
  readonly reconnectAttempt: number;
}

export interface GameClientOptions {
  readonly url: string;
  readonly reconnectWindowMs?: number;
  readonly now?: () => number;
  readonly createSocket?: (url: string) => WebSocket;
}

export const DEFAULT_WS_URL = 'ws://127.0.0.1:8787';
export const RECONNECT_WINDOW_MS = 180_000;
/** Server đóng socket cũ khi cùng account mở tab khác (ghế bị chiếm). */
export const SESSION_REPLACED_CLOSE_CODE = 4001;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 8_000;

/**
 * `VITE_WS_URL` (tuỳ chọn) được ưu tiên. Mặc định dùng cùng origin với trang
 * (`wss:` khi https, `ws:` khi http) để chạy sau TLS/proxy mà không hard-code host.
 * Chỉ fallback về server local khi không có `window` (unit test/SSR).
 */
export function resolveWsUrl(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length > 0) return trimmed;
  if (typeof window === 'undefined') return DEFAULT_WS_URL;
  const { protocol, host } = window.location;
  if (host.length === 0) return DEFAULT_WS_URL;
  return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}/ws`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class GameClient {
  private readonly url: string;
  private readonly now: () => number;
  private readonly createSocket: (url: string) => WebSocket;
  private readonly reconnectWindowMs: number;
  private readonly listeners = new Set<(snapshot: ClientSnapshot) => void>();
  private socket: WebSocket | null = null;
  private token: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectStartedAt: number | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private reconnectAttempt = 0;
  private manualClose = false;
  private snapshot: ClientSnapshot = {
    status: 'idle',
    room: null,
    state: null,
    stateReceivedAt: 0,
    hand: [],
    actionLog: [],
    error: null,
    reconnectAttempt: 0,
  };

  constructor(options: GameClientOptions) {
    this.url = options.url;
    this.now = options.now ?? (() => Date.now());
    this.reconnectWindowMs = options.reconnectWindowMs ?? RECONNECT_WINDOW_MS;
    this.createSocket = options.createSocket ?? ((url: string) => new WebSocket(url));
  }

  connect(): void {
    if (this.socket && this.socket.readyState <= 1) return;
    this.manualClose = false;
    this.openSocket();
  }

  close(): void {
    this.manualClose = true;
    this.clearReconnectTimer();
    this.token = null;
    this.reconnectAttempt = 0;
    this.socket?.close();
    this.socket = null;
    this.update({ status: 'closed' });
  }

  /** Nối lại phiên cũ sau reload bằng token đã lưu. */
  resume(token: string): void {
    this.token = token;
    this.manualClose = false;
    this.openSocket();
  }

  /** Về sảnh: bỏ phiên hiện tại và mở socket mới sạch. */
  leaveRoom(): void {
    this.token = null;
    this.manualClose = false;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    const previous = this.socket;
    this.socket = null;
    if (previous) previous.close();
    this.update({
      status: 'connecting',
      room: null,
      state: null,
      stateReceivedAt: 0,
      hand: [],
      actionLog: [],
      error: null,
      reconnectAttempt: 0,
    });
    this.openSocket();
  }

  getSnapshot(): ClientSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: ClientSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clearError(): void {
    if (this.snapshot.error) this.update({ error: null });
  }

  createRoom(nickname: string): boolean {
    this.clearError();
    return this.send({ t: 'createRoom', nickname: nickname.trim() });
  }

  joinRoom(code: string, nickname: string): boolean {
    this.clearError();
    return this.send({ t: 'joinRoom', code: code.trim().toUpperCase(), nickname: nickname.trim() });
  }

  setReady(ready: boolean): boolean {
    this.clearError();
    return this.send({ t: 'ready', ready });
  }

  start(): boolean {
    this.clearError();
    return this.send({ t: 'start' });
  }

  play(cards: readonly string[]): boolean {
    this.clearError();
    return this.send({ t: 'play', cards });
  }

  pass(): boolean {
    this.clearError();
    return this.send({ t: 'pass' });
  }

  surrender(): boolean {
    this.clearError();
    return this.send({ t: 'surrender' });
  }

  chop(cards: readonly string[], targetActionId: string): boolean {
    this.clearError();
    return this.send({ t: 'chop', cards, targetActionId });
  }

  private openSocket(): void {
    this.clearReconnectTimer();
    this.update({ status: this.token ? 'reconnecting' : 'connecting' });

    let socket: WebSocket;
    try {
      socket = this.createSocket(this.url);
    } catch {
      this.handleDisconnected();
      return;
    }

    this.socket = socket;
    socket.addEventListener('open', () => this.handleOpen(socket));
    socket.addEventListener('message', (event: MessageEvent) => this.handleRawMessage(event.data));
    socket.addEventListener('close', (event: CloseEvent) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (event.code === SESSION_REPLACED_CLOSE_CODE) {
        // Tab khác của cùng account đã chiếm ghế: dừng hẳn, không reconnect để tránh ping-pong.
        this.clearReconnectTimer();
        this.resetSession();
        this.manualClose = true;
        this.update({
          status: 'closed',
          error: { code: 'SESSION_REPLACED', message: 'Tài khoản đã được mở ở tab khác' },
        });
        return;
      }
      this.handleDisconnected();
    });
    socket.addEventListener('error', () => {
      // Browser fires 'close' ngay sau 'error'; xử lý một chỗ ở close.
    });
  }

  private handleOpen(socket: WebSocket): void {
    this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    this.reconnectStartedAt = null;
    if (this.token) {
      this.sendRaw(socket, { t: 'reconnect', token: this.token });
      return;
    }
    this.reconnectAttempt = 0;
    this.update({ status: 'open', reconnectAttempt: 0 });
  }

  private handleRawMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const type = parsed['t'];
    if (type !== 'room' && type !== 'state' && type !== 'error') return;
    this.handleMessage(parsed as unknown as ServerMessage);
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.t) {
      case 'room':
        this.token = message.room.you.token;
        this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        this.reconnectStartedAt = null;
        this.reconnectAttempt = 0;
        this.update({ room: message.room, status: 'open', error: null, reconnectAttempt: 0 });
        return;
      case 'state':
        this.update({
          state: message.state,
          stateReceivedAt: Date.now(),
          hand: message.you.hand,
          actionLog: message.actionLog ?? [],
          status: 'open',
        });
        return;
      case 'error':
        if (message.code === 'INVALID_TOKEN' || message.code === 'RECONNECT_EXPIRED') {
          this.resetSession();
          this.update({
            status: 'open',
            error: { code: message.code, message: message.message },
          });
          return;
        }
        this.update({ error: { code: message.code, message: message.message } });
        return;
    }
  }

  private handleDisconnected(): void {
    if (this.manualClose) {
      this.update({ status: 'closed' });
      return;
    }
    if (!this.token) {
      this.update({
        status: 'closed',
        error: { code: 'CLIENT_OFFLINE', message: 'mất kết nối tới server' },
      });
      return;
    }

    const now = this.now();
    if (this.reconnectStartedAt === null) this.reconnectStartedAt = now;
    if (now - this.reconnectStartedAt > this.reconnectWindowMs) {
      this.resetSession();
      this.update({
        status: 'closed',
        error: { code: 'RECONNECT_WINDOW_EXPIRED', message: 'quá 3 phút không nối lại được' },
      });
      return;
    }

    this.reconnectAttempt += 1;
    this.update({ status: 'reconnecting', reconnectAttempt: this.reconnectAttempt });
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private resetSession(): void {
    this.token = null;
    this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    this.reconnectStartedAt = null;
    this.reconnectAttempt = 0;
    this.update({
      room: null,
      state: null,
      stateReceivedAt: 0,
      hand: [],
      actionLog: [],
      reconnectAttempt: 0,
    });
  }

  private send(message: ClientMessage): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.update({
        error: { code: 'CLIENT_OFFLINE', message: 'chưa kết nối tới server' },
      });
      return false;
    }
    return this.sendRaw(socket, message);
  }

  private sendRaw(socket: WebSocket, message: ClientMessage): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private update(patch: Partial<ClientSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener(this.snapshot);
  }
}
