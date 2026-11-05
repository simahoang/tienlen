import type {
  ActionLogView,
  CardView,
  ChatMessageView,
  ClientMessage,
  DenBaiView,
  PublicGameState,
  RoomSummaryView,
  RoomView,
  ServerMessage,
  TourEndView,
  TourPausedView,
  TourResultView,
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
  /** Lần đền 13 lá gần nhất server broadcast; null = chưa có. */
  readonly lastDenBai: DenBaiView | null;
  /** Bảng điểm ván + điểm tour gần nhất (overlay KET_QUA_VAN); null = chưa có. */
  readonly tourResult: TourResultView | null;
  /** TAM_DUNG khi thiếu người; null = không tạm dừng. */
  readonly tourPaused: TourPausedView | null;
  /** Bảng tổng kết cuối tour; null = tour chưa kết thúc. */
  readonly tourEnd: TourEndView | null;
  /** Danh sách phòng ở sảnh; null = chưa có dữ liệu (đang tải / chưa xin). */
  readonly roomList: readonly RoomSummaryView[] | null;
  /** Lịch sử + tin chat live của phòng hiện tại (tối đa `CHAT_HISTORY_MAX`). */
  readonly chatMessages: readonly ChatMessageView[];
}

/** Số tin chat client giữ lại (khớp `CHAT_HISTORY_MAX` phía server). */
const CHAT_KEEP_MAX = 50;

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
    lastDenBai: null,
    tourResult: null,
    tourPaused: null,
    tourEnd: null,
    roomList: null,
    chatMessages: [],
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
      lastDenBai: null,
      tourResult: null,
      tourPaused: null,
      tourEnd: null,
      roomList: null,
      chatMessages: [],
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

  createRoom(nickname: string, soVan?: number): boolean {
    this.clearError();
    return this.send({
      t: 'createRoom',
      nickname: nickname.trim(),
      ...(soVan === undefined ? {} : { soVan }),
    });
  }

  joinRoom(code: string, nickname: string): boolean {
    this.clearError();
    return this.send({ t: 'joinRoom', code: code.trim().toUpperCase(), nickname: nickname.trim() });
  }

  /** Xin danh sách phòng ở sảnh; server trả `roomList` (và push khi có thay đổi). */
  listRooms(): boolean {
    return this.send({ t: 'listRooms' });
  }

  /** Khán giả xin vào ghế trống khi phòng còn mở (server tự kiểm tra điều kiện). */
  joinSeat(code: string): boolean {
    this.clearError();
    return this.send({ t: 'joinSeat', code: code.trim().toUpperCase() });
  }

  /**
   * Khán giả rời phòng nhưng giữ socket để quay lại sảnh: xoá phiên local rồi xin
   * lại danh sách phòng. Không đóng socket (khác `leaveRoom`).
   */
  leaveWatch(): boolean {
    this.clearError();
    const sent = this.send({ t: 'leaveWatch' });
    if (!sent) return false;
    this.token = null;
    this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    this.reconnectStartedAt = null;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    this.update({
      status: 'open',
      room: null,
      state: null,
      stateReceivedAt: 0,
      hand: [],
      actionLog: [],
      reconnectAttempt: 0,
      lastDenBai: null,
      tourResult: null,
      tourPaused: null,
      tourEnd: null,
      roomList: null,
      chatMessages: [],
    });
    this.listRooms();
    return true;
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

  /** Rời tour: bỏ điểm tour, trả ghế trống (doc-4 §5.4). */
  leaveTour(): boolean {
    this.clearError();
    return this.send({ t: 'leaveTour' });
  }

  /** Chủ phòng kết thúc sớm tour đang dừng/giữa các ván (doc-4 §3.1). */
  endTour(): boolean {
    this.clearError();
    return this.send({ t: 'endTour' });
  }

  /** Tour mới cùng ghế sau bảng tổng kết; điểm từ 0. */
  newTour(soVan?: number): boolean {
    this.clearError();
    return this.send({ t: 'newTour', ...(soVan === undefined ? {} : { soVan }) });
  }

  /** Chat phòng; server validate role + rate limit rồi broadcast `chat`. */
  sendChat(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length === 0) return false;
    return this.send({ t: 'chat', text: trimmed });
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
    } else {
      this.reconnectAttempt = 0;
      this.update({ status: 'open', reconnectAttempt: 0 });
    }
    // Luôn xin danh sách phòng để sảnh có dữ liệu ngay cả sau reconnect.
    this.sendRaw(socket, { t: 'listRooms' });
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
    if (
      type !== 'room' &&
      type !== 'state' &&
      type !== 'error' &&
      type !== 'denBai' &&
      type !== 'tourResult' &&
      type !== 'tourPaused' &&
      type !== 'tourEnd' &&
      type !== 'roomList' &&
      type !== 'chat' &&
      type !== 'chatHistory' &&
      type !== 'leftTour'
    ) {
      return;
    }
    this.handleMessage(parsed as unknown as ServerMessage);
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.t) {
      case 'room': {
        const previous = this.snapshot.room;
        this.token = message.room.you.token;
        this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        this.reconnectStartedAt = null;
        this.reconnectAttempt = 0;
        const roomChanged = previous !== null && previous.code !== message.room.code;
        // Khán giả bấm "Vào ghế": seat -1 -> ghế thật, danh sách sảnh đã cũ.
        const tookSeat =
          previous !== null &&
          previous.code === message.room.code &&
          previous.you.seat < 0 &&
          message.room.you.seat >= 0;
        if (roomChanged || tookSeat) {
          this.update({
            room: message.room,
            status: 'open',
            error: null,
            reconnectAttempt: 0,
            roomList: null,
            ...(roomChanged ? { chatMessages: [] } : {}),
          });
          this.listRooms();
          return;
        }
        this.update({ room: message.room, status: 'open', error: null, reconnectAttempt: 0 });
        return;
      }
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
            roomList: null,
          });
          this.listRooms();
          return;
        }
        this.update({ error: { code: message.code, message: message.message } });
        return;
      case 'denBai':
        this.update({ lastDenBai: message.event });
        return;
      case 'tourResult':
        this.update({
          tourResult: message.result,
          tourPaused: null,
          tourEnd: null,
        });
        return;
      case 'tourPaused':
        this.update({ tourPaused: message.paused, tourEnd: null });
        return;
      case 'tourEnd':
        this.update({ tourEnd: message.summary, tourResult: null, tourPaused: null });
        return;
      case 'chatHistory':
        this.update({ chatMessages: message.messages.slice(-CHAT_KEEP_MAX) });
        return;
      case 'chat':
        this.update({
          chatMessages: [...this.snapshot.chatMessages, message.message].slice(-CHAT_KEEP_MAX),
        });
        return;
      case 'leftTour':
        // Đã rời tour: server detach khỏi phòng nhưng giữ socket để về sảnh ngay.
        this.token = null;
        this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        this.reconnectStartedAt = null;
        this.reconnectAttempt = 0;
        this.clearReconnectTimer();
        this.update({
          status: 'open',
          room: null,
          state: null,
          stateReceivedAt: 0,
          hand: [],
          actionLog: [],
          error: null,
          reconnectAttempt: 0,
          lastDenBai: null,
          tourResult: null,
          tourPaused: null,
          tourEnd: null,
          roomList: null,
          chatMessages: [],
        });
        this.listRooms();
        return;
      case 'roomList': {
        const current = this.snapshot.room;
        const spectating =
          current !== null &&
          (current.you.role === 'spectator' || current.you.seat === -1);
        const stillListed =
          current !== null && message.rooms.some((entry) => entry.code === current.code);
        if (spectating && !stillListed) {
          // Phòng đã giải tán: khán giả tự về sảnh, giữ socket để nhận danh sách mới.
          this.token = null;
          this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
          this.reconnectStartedAt = null;
          this.reconnectAttempt = 0;
          this.clearReconnectTimer();
          this.update({
            status: 'open',
            room: null,
            state: null,
            stateReceivedAt: 0,
            hand: [],
            actionLog: [],
            error: null,
            reconnectAttempt: 0,
            lastDenBai: null,
            tourResult: null,
            tourPaused: null,
            tourEnd: null,
            roomList: message.rooms,
            chatMessages: [],
          });
          return;
        }
        this.update({ roomList: message.rooms });
        return;
      }
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
      tourResult: null,
      tourPaused: null,
      tourEnd: null,
      chatMessages: [],
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
