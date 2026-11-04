import { randomInt, randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { rules } from '../src/data/index';
import {
  applyIntent,
  applyTimeout,
  calculateScore,
  createGame,
  type GameRulesInput,
  type GameState,
  type Intent,
} from '../src/rules/index';
import type { Card } from '../src/rules/types';
import type { AuthedSocket, Principal } from './auth/principal';
import type { GameStore } from './db';
import {
  MAX_SEATS,
  MIN_SEATS,
  NICKNAME_MAX,
  ROOM_CODE_LENGTH,
  parseClientMessage,
  type ActionLogView,
  type CardView,
  type ChopWindowView,
  type ClientMessage,
  type PublicGameState,
  type RankingView,
  type RoomPhase,
  type RoomView,
  type ServerMessage,
  type TableView,
} from '../src/net/protocol';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULT_MAX_ROOMS = 500;
/** Mặc định 10 phút: giữ phòng finished đủ lâu để client xem kết quả rồi mới dọn. */
const DEFAULT_ROOM_TTL_MS = 600_000;
/** Mã đóng WS khi một tab khác của cùng account chiếm ghế. */
const CLOSE_REPLACED = 4001;

export interface RoomLogger {
  warn(message: string): void;
}

export interface RoomManagerConfig {
  /** Thời gian mỗi lượt (ms). Test dùng 100-300ms. */
  readonly turnMs: number;
  /** Độ dài cửa sổ chặt ngoài lượt (ms), ghi đè `rules.chatNgoaiLuot.windowMs`. */
  readonly windowMs: number;
  /** Ân hạn disconnect khi đang tới lượt (ms), mặc định 10000. */
  readonly disconnectMs: number;
  /** Hạn reconnect (ms), mặc định 180000. */
  readonly reconnectMs: number;
  readonly rateMax: number;
  readonly rateWindowMs: number;
  /** TTL dọn phòng finished sau khi không còn ai kết nối (ms), mặc định 600000. */
  readonly roomTtlMs?: number;
  /** Giới hạn phòng đồng thời, mặc định 500. */
  readonly maxRooms?: number;
  /** Logger lỗi socket/room; mặc định dùng console.warn. */
  readonly logger?: RoomLogger;
  /** Hook test: seed cố định. */
  readonly seed?: number;
  /** Hook test: chia tay thủ công (số tay = số người). */
  readonly hands?: readonly (readonly Card[])[];
  readonly startingPlayerIndex?: number;
  /** Store SQLite; null/undefined = chạy không lưu DB. */
  readonly store?: GameStore;
}

interface RoomPlayer {
  seat: number;
  /** Danh tính server-side (principal.username); dùng để chặn 1 account nhiều ghế. */
  readonly account: string;
  readonly nickname: string;
  readonly token: string;
  readonly userId: number | null;
  ready: boolean;
  connected: boolean;
  surrendered: boolean;
  socket: WebSocket | null;
}

interface Binding {
  readonly room: Room;
  readonly player: RoomPlayer;
}

export class Room {
  readonly code: string;
  readonly createdAt: number;
  hostSeat = 0;
  phase: RoomPhase = 'lobby';
  game: GameState | null = null;
  matchId: number | null = null;
  actionSeq = 0;
  resultRecorded = false;
  turnDeadline: number | null = null;
  /** Thời gian còn lại của lượt khi timer bị tạm dừng vì chopWindow. */
  turnRemainingMs: number | null = null;
  readonly players: RoomPlayer[] = [];
  readonly rateHits: number[] = [];
  turnTimer: NodeJS.Timeout | null = null;
  windowTimer: NodeJS.Timeout | null = null;
  cleanupTimer: NodeJS.Timeout | null = null;
  readonly graceTimers = new Map<number, NodeJS.Timeout>();
  readonly expiryTimers = new Map<number, NodeJS.Timeout>();

  constructor(code: string) {
    this.code = code;
    this.createdAt = Date.now();
  }
}

function makeRoomCode(): string {
  let code = '';
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    code += ROOM_ALPHABET[randomInt(0, ROOM_ALPHABET.length)];
  }
  return code;
}

/** Tên hiển thị lấy từ principal, không bao giờ lấy từ client. */
function nicknameOf(principal: Principal): string {
  const preferred = (principal.displayName || principal.username).trim().slice(0, NICKNAME_MAX);
  return preferred.length > 0 ? preferred : principal.username.slice(0, NICKNAME_MAX);
}

function toCardView(card: { id: string; rank: CardView['rank']; suit: CardView['suit'] }): CardView {
  return { id: card.id, rank: card.rank, suit: card.suit };
}

function engineRules(config: RoomManagerConfig): GameRulesInput {
  return {
    ...rules,
    chatNgoaiLuot: { ...rules.chatNgoaiLuot, windowMs: config.windowMs },
  };
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly bindings = new Map<WebSocket, Binding>();
  private readonly accountSockets = new Map<string, WebSocket>();

  constructor(private readonly config: RoomManagerConfig) {}

  handleConnection(socket: WebSocket): void {
    socket.on('message', (data: unknown) => {
      this.handleText(socket, typeof data === 'string' ? data : String(data));
    });
    socket.on('close', () => this.handleClose(socket));
    // Thiếu handler 'error' thì một lỗi socket sẽ throw và có thể giết process.
    socket.on('error', (error: unknown) => this.handleSocketError(socket, error));
  }

  handleText(socket: WebSocket, text: string): void {
    const result = parseClientMessage(text);
    if (!result.ok) {
      this.sendError(socket, result.code, result.message);
      return;
    }
    this.dispatch(socket, result.message);
  }

  private dispatch(socket: WebSocket, message: ClientMessage): void {
    switch (message.t) {
      case 'createRoom':
        this.createRoom(socket);
        return;
      case 'joinRoom':
        this.joinRoom(socket, message.code);
        return;
      case 'ready':
        this.setReady(socket, message.ready);
        return;
      case 'start':
        this.startGame(socket);
        return;
      case 'play':
      case 'pass':
      case 'surrender':
      case 'chop':
        this.handleIntent(socket, message);
        return;
      case 'reconnect':
        this.reconnect(socket, message.token);
        return;
      default:
        this.sendError(socket, 'UNKNOWN_MESSAGE', 'loại message không hỗ trợ');
    }
  }

  /** Principal do server gắn lúc upgrade; null nghĩa là socket chưa xác thực. */
  private principalOf(socket: WebSocket): Principal | null {
    return (socket as AuthedSocket).principal ?? null;
  }

  /**
   * Đảm bảo một account chỉ giữ một ghế: đóng socket cũ (4001) trước khi socket mới vào phòng.
   * Trả false khi account đang ở phòng khác lobby — không cướp ghế giữa ván.
   */
  private claimAccount(account: string, socket: WebSocket): boolean {
    const current = this.accountSockets.get(account);
    if (!current || current === socket) {
      this.accountSockets.set(account, socket);
      return true;
    }
    const oldBinding = this.bindings.get(current);
    if (!oldBinding) {
      this.accountSockets.set(account, socket);
      return true;
    }
    if (oldBinding.room.phase === 'playing') {
      // Đang chơi: không cướp ghế giữa ván. Tab cũ phải thoát, tab mới bị từ chối.
      current.close(CLOSE_REPLACED, 'REPLACED');
      return false;
    }
    // Lobby hoặc finished (ván đã xong, ghế không còn giá trị): nhường ghế ngay.
    this.removeFromLobby(oldBinding.room, oldBinding.player);
    this.bindings.delete(current);
    current.close(CLOSE_REPLACED, 'REPLACED');
    this.accountSockets.set(account, socket);
    return true;
  }

  /** Gỡ player khỏi phòng lobby: sắp lại ghế, chỉnh host, dọn phòng nếu trống. */
  private removeFromLobby(room: Room, player: RoomPlayer): void {
    const index = room.players.indexOf(player);
    if (index >= 0) room.players.splice(index, 1);
    if (room.players.length === 0) {
      this.clearAllTimers(room);
      this.rooms.delete(room.code);
      return;
    }
    room.players.sort((a, b) => a.seat - b.seat);
    room.players.forEach((entry, seatIndex) => {
      entry.seat = seatIndex;
    });
    if (!room.players.some((entry) => entry.seat === room.hostSeat)) {
      room.hostSeat = room.players[0]?.seat ?? 0;
    }
    this.broadcastRoom(room);
  }

  private createRoom(socket: WebSocket): void {
    const principal = this.principalOf(socket);
    if (!principal) {
      this.sendError(socket, 'UNAUTHENTICATED', 'cần đăng nhập');
      return;
    }
    if (this.bindings.has(socket)) {
      this.sendError(socket, 'ALREADY_IN_ROOM', 'socket đã ở trong một phòng');
      return;
    }
    if (this.rooms.size >= (this.config.maxRooms ?? DEFAULT_MAX_ROOMS)) {
      this.sendError(socket, 'SERVER_FULL', 'server đã đạt giới hạn phòng');
      return;
    }
    const account = principal.username;
    if (!this.claimAccount(account, socket)) {
      this.sendError(
        socket,
        'ALREADY_IN_GAME',
        'tài khoản đang trong ván khác, hãy quay lại tab cũ hoặc chờ ván kết thúc',
      );
      return;
    }
    const nickname = nicknameOf(principal);
    let code = makeRoomCode();
    while (this.rooms.has(code)) code = makeRoomCode();

    const room = new Room(code);
    const player: RoomPlayer = {
      seat: 0,
      account,
      nickname,
      token: randomUUID(),
      userId: this.config.store?.createUser(nickname) ?? null,
      ready: false,
      connected: true,
      surrendered: false,
      socket,
    };
    room.players.push(player);
    room.hostSeat = 0;
    this.rooms.set(code, room);
    this.bindings.set(socket, { room, player });
    this.sendRoom(room, player);
  }

  private joinRoom(socket: WebSocket, code: string): void {
    const principal = this.principalOf(socket);
    if (!principal) {
      this.sendError(socket, 'UNAUTHENTICATED', 'cần đăng nhập');
      return;
    }
    if (this.bindings.has(socket)) {
      this.sendError(socket, 'ALREADY_IN_ROOM', 'socket đã ở trong một phòng');
      return;
    }
    const room = this.rooms.get(code);
    if (!room) {
      this.sendError(socket, 'ROOM_NOT_FOUND', `không tìm thấy phòng ${code}`);
      return;
    }
    if (room.phase !== 'lobby') {
      this.sendError(socket, 'GAME_IN_PROGRESS', 'ván đã bắt đầu, không thể vào giữa ván');
      return;
    }
    const account = principal.username;
    if (!this.claimAccount(account, socket)) {
      this.sendError(
        socket,
        'ALREADY_IN_GAME',
        'tài khoản đang trong ván khác, hãy quay lại tab cũ hoặc chờ ván kết thúc',
      );
      return;
    }
    const seat = this.firstFreeSeat(room);
    if (seat === null) {
      this.sendError(socket, 'ROOM_FULL', 'phòng đã đủ ghế');
      return;
    }
    const nickname = nicknameOf(principal);
    const player: RoomPlayer = {
      seat,
      account,
      nickname,
      token: randomUUID(),
      userId: this.config.store?.createUser(nickname) ?? null,
      ready: false,
      connected: true,
      surrendered: false,
      socket,
    };
    room.players.push(player);
    this.bindings.set(socket, { room, player });
    this.sendRoom(room, player);
    this.broadcastRoom(room);
  }

  private firstFreeSeat(room: Room): number | null {
    for (let seat = 0; seat < MAX_SEATS; seat += 1) {
      if (!room.players.some((player) => player.seat === seat)) return seat;
    }
    return null;
  }

  private setReady(socket: WebSocket, ready: boolean): void {
    const binding = this.bindings.get(socket);
    if (!binding) {
      this.sendError(socket, 'NOT_IN_ROOM', 'chưa ở trong phòng');
      return;
    }
    if (binding.room.phase !== 'lobby') {
      this.sendError(socket, 'ROOM_NOT_LOBBY', 'ván đã bắt đầu, không đổi sẵn sàng');
      return;
    }
    binding.player.ready = ready;
    this.broadcastRoom(binding.room);
    this.maybeAutoStart(binding.room);
  }

  private maybeAutoStart(room: Room): void {
    if (room.phase !== 'lobby') return;
    if (room.players.length < MIN_SEATS) return;
    if (!room.players.every((player) => player.ready)) return;
    this.startGameInternal(room);
  }

  private startGame(socket: WebSocket): void {
    const binding = this.bindings.get(socket);
    if (!binding) {
      this.sendError(socket, 'NOT_IN_ROOM', 'chưa ở trong phòng');
      return;
    }
    const room = binding.room;
    if (room.phase !== 'lobby') {
      this.sendError(socket, 'ROOM_NOT_LOBBY', 'ván đã bắt đầu');
      return;
    }
    if (binding.player.seat !== room.hostSeat) {
      this.sendError(socket, 'NOT_HOST', 'chỉ chủ phòng được bắt đầu');
      return;
    }
    if (room.players.length < MIN_SEATS) {
      this.sendError(socket, 'NOT_ENOUGH_PLAYERS', 'cần ít nhất 2 người');
      return;
    }
    this.startGameInternal(room);
  }

  private startGameInternal(room: Room): void {
    if (room.phase !== 'lobby') return;
    if (room.players.length < MIN_SEATS) return;
    room.players.sort((a, b) => a.seat - b.seat);
    room.players.forEach((player, index) => {
      player.seat = index;
      player.ready = false;
      player.surrendered = false;
    });
    room.hostSeat = 0;
    room.rateHits.length = 0;

    const seed = this.config.seed ?? randomInt(1, 2_147_483_647);
    room.game = createGame({
      seed,
      players: room.players.length,
      rules: engineRules(this.config),
      ...(this.config.hands ? { hands: this.config.hands } : {}),
      ...(this.config.startingPlayerIndex === undefined
        ? {}
        : { startingPlayerIndex: this.config.startingPlayerIndex }),
    });
    room.phase = room.game.phase === 'finished' ? 'finished' : 'playing';
    room.turnDeadline = null;
    room.actionSeq = 0;
    room.resultRecorded = false;
    room.matchId =
      this.config.store?.createMatch({
        roomCode: room.code,
        seed,
        rulesVersion: rules.rulesVersion,
        config: { windowMs: this.config.windowMs, turnMs: this.config.turnMs },
        players: room.players.map((player) => ({
          seat: player.seat,
          nickname: player.nickname,
          userId: player.userId,
        })),
      }) ?? null;
    if (room.phase === 'finished') this.persistResult(room);
    this.broadcastRoom(room);
    this.syncTimers(room);
    this.broadcastState(room);
  }

  private handleIntent(
    socket: WebSocket,
    message: Extract<ClientMessage, { t: 'play' | 'pass' | 'surrender' | 'chop' }>,
  ): void {
    const binding = this.bindings.get(socket);
    if (!binding) {
      this.sendError(socket, 'NOT_IN_ROOM', 'chưa ở trong phòng');
      return;
    }
    const room = binding.room;
    const seat = binding.player.seat;
    const nowMs = Date.now();
    let intent: Intent;
    switch (message.t) {
      case 'play':
        intent = { type: 'play', seat, cards: message.cards };
        break;
      case 'pass':
        intent = { type: 'pass', seat };
        break;
      case 'surrender':
        intent = { type: 'surrender', seat };
        break;
      case 'chop':
        intent = {
          type: 'chop',
          seat,
          cards: message.cards,
          targetActionId: message.targetActionId,
        };
        break;
      default:
        return;
    }

    if (this.isRateLimited(room)) {
      this.recordAction(room, seat, intent.type, { intent, nowMs }, 'RATE_LIMITED');
      this.sendError(socket, 'RATE_LIMITED', 'quá 5 intent/giây trong phòng');
      return;
    }
    if (room.phase !== 'playing' || !room.game) {
      this.recordAction(room, seat, intent.type, { intent, nowMs }, 'ROOM_NOT_PLAYING');
      this.sendError(socket, 'ROOM_NOT_PLAYING', 'ván chưa bắt đầu hoặc đã kết thúc');
      return;
    }

    const result = applyIntent(room.game, intent, { nowMs });
    if (result.error) {
      this.recordAction(room, seat, intent.type, { intent, nowMs }, result.error.code);
      this.sendError(socket, result.error.code, result.error.message);
      return;
    }
    if (intent.type === 'surrender') {
      // Rời ván chủ động: token reconnect hết hiệu lực ngay, không chờ expiry timer.
      this.markLeft(room, binding.player);
    }
    this.recordIntent(room, intent, nowMs);
    this.applyResult(room, result.state);
  }

  private applyResult(room: Room, state: GameState): void {
    this.clearTurnTimer(room);
    this.clearWindowTimer(room);
    room.game = state;
    if (state.phase === 'finished') {
      room.phase = 'finished';
      room.turnDeadline = null;
      this.clearAllTimers(room);
      this.persistResult(room);
    }
    this.syncTimers(room);
    this.broadcastState(room);
    if (room.phase === 'finished') {
      this.broadcastRoom(room);
      this.maybeScheduleCleanup(room);
    }
  }

  private syncTimers(room: Room): void {
    const game = room.game;
    if (room.phase !== 'playing' || !game || game.phase !== 'playing') {
      room.turnDeadline = null;
      room.turnRemainingMs = null;
      return;
    }
    if (game.chopWindow) {
      // Người kế tiếp bắt đầu lượt mới và bị pause trong window → giữ đủ turnMs,
      // KHÔNG lấy deadline cũ của người vừa đánh (sẽ làm người sau bị xử oan).
      if (game.rules.chatNgoaiLuot.pauseTurnTimer) {
        room.turnRemainingMs = this.config.turnMs;
      }
      room.turnDeadline = null;
      this.scheduleWindowClose(room, game.chopWindow.closesAt, game.chopWindow.targetActionId);
      return;
    }
    this.scheduleTurnTimer(room);
  }

  private scheduleTurnTimer(room: Room): void {
    this.clearTurnTimer(room);
    if (room.phase !== 'playing' || !room.game || room.game.phase !== 'playing') {
      room.turnDeadline = null;
      room.turnRemainingMs = null;
      return;
    }
    if (room.game.chopWindow && room.game.rules.chatNgoaiLuot.pauseTurnTimer) {
      room.turnDeadline = null;
      return;
    }
    const remaining = Math.max(
      0,
      Math.min(room.turnRemainingMs ?? this.config.turnMs, this.config.turnMs),
    );
    room.turnRemainingMs = null;
    const deadline = Date.now() + remaining;
    room.turnDeadline = deadline;
    room.turnTimer = setTimeout(() => this.onTurnTimeout(room, deadline), remaining);
  }

  private onTurnTimeout(room: Room, deadline: number): void {
    room.turnTimer = null;
    if (room.turnDeadline !== deadline) return;
    const game = room.game;
    if (room.phase !== 'playing' || !game || game.phase !== 'playing') return;
    const seat = game.turn;
    const nowMs = Date.now();
    const result = applyTimeout(game, { nowMs });
    if (result.error) return;
    this.recordTimeout(room, seat, nowMs);
    this.applyResult(room, result.state);
  }

  private scheduleWindowClose(room: Room, closesAt: number, targetActionId: string): void {
    this.clearWindowTimer(room);
    const delay = Math.max(0, closesAt - Date.now());
    room.windowTimer = setTimeout(() => {
      room.windowTimer = null;
      const game = room.game;
      if (room.phase !== 'playing' || !game || game.phase !== 'playing') return;
      if (!game.chopWindow || game.chopWindow.targetActionId !== targetActionId) return;
      // Window hết hạn: engine tự reject intent sau closesAt, server chỉ dọn state + resume timer.
      room.game = { ...game, chopWindow: null };
      this.syncTimers(room);
      this.broadcastState(room);
    }, delay);
  }

  private recordIntent(room: Room, intent: Intent, nowMs: number): void {
    this.recordAction(room, intent.seat, intent.type, { intent, nowMs });
  }

  private recordTimeout(room: Room, seat: number, nowMs: number): void {
    this.recordAction(room, seat, 'timeout', { nowMs });
  }

  private recordAction(
    room: Room,
    seat: number,
    type: string,
    payload: unknown,
    result = 'ok',
  ): void {
    const store = this.config.store;
    if (!store || room.matchId === null) return;
    room.actionSeq += 1;
    store.appendAction({
      matchId: room.matchId,
      seq: room.actionSeq,
      seat,
      type,
      payload,
      result,
    });
  }

  private persistResult(room: Room): void {
    const store = this.config.store;
    const game = room.game;
    if (!store || room.matchId === null || room.resultRecorded) return;
    if (!game || game.phase !== 'finished') return;
    room.resultRecorded = true;
    store.finishMatch(room.matchId, {
      ranking: game.ranking,
      scores: calculateScore(game).deltas,
      actionCount: game.actionCount,
      rulesVersion: rules.rulesVersion,
    });
  }

  private isRateLimited(room: Room): boolean {
    const now = Date.now();
    const cutoff = now - this.config.rateWindowMs;
    const recent = room.rateHits.filter((time) => time > cutoff);
    room.rateHits.length = 0;
    room.rateHits.push(...recent);
    if (room.rateHits.length >= this.config.rateMax) return true;
    room.rateHits.push(now);
    return false;
  }

  private reconnect(socket: WebSocket, token: string): void {
    const principal = this.principalOf(socket);
    if (!principal) {
      this.sendError(socket, 'UNAUTHENTICATED', 'cần đăng nhập');
      return;
    }
    if (this.bindings.has(socket)) {
      this.sendError(socket, 'ALREADY_IN_ROOM', 'socket đã ở trong một phòng');
      return;
    }
    let found: Binding | null = null;
    for (const room of this.rooms.values()) {
      const player = room.players.find((entry) => entry.token === token);
      if (player) {
        found = { room, player };
        break;
      }
    }
    if (!found) {
      this.sendError(socket, 'INVALID_TOKEN', 'token không khớp phòng/ván nào');
      return;
    }
    const { room, player } = found;
    const account = principal.username;
    if (player.account !== account) {
      // Token là bí mật của người chơi khác: không chiếm ghế, không đóng socket của họ.
      this.sendError(socket, 'INVALID_TOKEN', 'token không thuộc tài khoản này');
      return;
    }
    if (player.surrendered) {
      this.sendError(socket, 'RECONNECT_EXPIRED', 'đã quá hạn reconnect, ghế đã xử thua');
      return;
    }
    const previous = player.socket;
    if (previous && previous !== socket) {
      this.bindings.delete(previous);
      previous.close(CLOSE_REPLACED, 'REPLACED');
    }
    // Các socket khác của cùng account (tab khác/phòng khác) cũng phải nhường.
    for (const [other, binding] of this.bindings) {
      if (other === socket) continue;
      if (binding.player.account !== account) continue;
      if (binding.player === player) {
        this.bindings.delete(other);
      }
      other.close(CLOSE_REPLACED, 'REPLACED');
    }
    player.socket = socket;
    player.connected = true;
    this.bindings.set(socket, { room, player });
    this.accountSockets.set(account, socket);
    this.cancelCleanup(room);
    this.clearGrace(room, player.seat);
    this.clearExpiry(room, player.seat);
    this.sendRoom(room, player);
    this.broadcastRoom(room);
    if (room.game) {
      // §3.2: reconnect nhận full state + action log công khai; người khác nhận state thường.
      this.sendState(room, player, { includeLog: true });
      for (const other of room.players) {
        if (other !== player) this.sendState(room, other);
      }
    }
  }

  private handleClose(socket: WebSocket): void {
    const binding = this.bindings.get(socket);
    if (!binding) return;
    this.bindings.delete(socket);
    const { room, player } = binding;
    if (this.accountSockets.get(player.account) === socket) {
      this.accountSockets.delete(player.account);
    }
    player.socket = null;
    player.connected = false;

    if (room.phase === 'lobby') {
      this.removeFromLobby(room, player);
      return;
    }

    this.broadcastRoom(room);
    this.broadcastState(room);
    this.maybeScheduleCleanup(room);
    if (room.phase !== 'playing' || !room.game || room.game.phase !== 'playing') return;
    if (room.game.turn === player.seat) this.scheduleGrace(room, player);
    this.scheduleExpiry(room, player);
  }

  private handleSocketError(socket: WebSocket, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const writer = this.config.logger ?? { warn: (text: string): void => console.warn(text) };
    try {
      writer.warn(`[game2-ws] lỗi socket: ${message}`);
    } catch {
      // logger hỏng không được làm sập process
    }
    this.handleClose(socket);
    try {
      socket.terminate();
    } catch {
      // socket đã đóng/không còn kết nối
    }
  }

  /** Đánh dấu ghế đã rời ván vĩnh viễn: token reconnect không dùng lại được. */
  private markLeft(room: Room, player: RoomPlayer): void {
    player.surrendered = true;
    this.clearGrace(room, player.seat);
    this.clearExpiry(room, player.seat);
  }

  private scheduleGrace(room: Room, player: RoomPlayer): void {
    this.clearGrace(room, player.seat);
    const seat = player.seat;
    const timer = setTimeout(() => {
      room.graceTimers.delete(seat);
      if (player.connected) return;
      const game = room.game;
      if (room.phase !== 'playing' || !game || game.phase !== 'playing') return;
      if (game.turn !== seat) return;
      // §3.2: mất kết nối đang tới lượt → sau 10s auto như timeout.
      const nowMs = Date.now();
      const result = applyTimeout(game, { nowMs });
      if (result.error) return;
      this.recordTimeout(room, seat, nowMs);
      this.applyResult(room, result.state);
    }, this.config.disconnectMs);
    room.graceTimers.set(seat, timer);
  }

  private scheduleExpiry(room: Room, player: RoomPlayer): void {
    this.clearExpiry(room, player.seat);
    const seat = player.seat;
    const timer = setTimeout(() => {
      room.expiryTimers.delete(seat);
      if (player.connected || player.surrendered) return;
      // Quá hạn reconnect = rời ván vĩnh viễn. Set cờ TRƯỚC khi gọi engine để token
      // vẫn bị vô hiệu kể cả khi engine trả ALREADY_SURRENDERED / ván đã kết thúc.
      this.markLeft(room, player);
      const game = room.game;
      if (room.phase !== 'playing' || !game || game.phase !== 'playing') return;
      const intent: Intent = { type: 'surrender', seat };
      const nowMs = Date.now();
      const result = applyIntent(game, intent, { nowMs });
      if (result.error) return;
      this.recordIntent(room, intent, nowMs);
      this.applyResult(room, result.state);
    }, this.config.reconnectMs);
    room.expiryTimers.set(seat, timer);
  }

  private clearTurnTimer(room: Room): void {
    if (room.turnTimer) {
      clearTimeout(room.turnTimer);
      room.turnTimer = null;
    }
  }

  private clearWindowTimer(room: Room): void {
    if (room.windowTimer) {
      clearTimeout(room.windowTimer);
      room.windowTimer = null;
    }
  }

  private clearGrace(room: Room, seat: number): void {
    const timer = room.graceTimers.get(seat);
    if (timer) {
      clearTimeout(timer);
      room.graceTimers.delete(seat);
    }
  }

  private clearExpiry(room: Room, seat: number): void {
    const timer = room.expiryTimers.get(seat);
    if (timer) {
      clearTimeout(timer);
      room.expiryTimers.delete(seat);
    }
  }

  private clearAllTimers(room: Room): void {
    this.clearTurnTimer(room);
    this.clearWindowTimer(room);
    this.cancelCleanup(room);
    for (const timer of room.graceTimers.values()) clearTimeout(timer);
    room.graceTimers.clear();
    for (const timer of room.expiryTimers.values()) clearTimeout(timer);
    room.expiryTimers.clear();
  }

  /**
   * Phòng finished chỉ bị dọn khi không còn ai kết nối, sau `roomTtlMs`.
   * Tránh rò rỉ room → chạm `maxRooms` và trả `SERVER_FULL` sai.
   */
  private maybeScheduleCleanup(room: Room): void {
    if (room.cleanupTimer) return;
    if (room.phase !== 'finished') return;
    if (room.players.some((player) => player.connected)) return;
    const ttl = this.config.roomTtlMs ?? DEFAULT_ROOM_TTL_MS;
    room.cleanupTimer = setTimeout(() => {
      room.cleanupTimer = null;
      if (this.rooms.get(room.code) !== room) return;
      if (room.players.some((player) => player.connected)) return;
      this.deleteRoom(room);
    }, ttl);
  }

  private cancelCleanup(room: Room): void {
    if (!room.cleanupTimer) return;
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }

  private deleteRoom(room: Room): void {
    this.clearAllTimers(room);
    room.game = null;
    room.matchId = null;
    this.rooms.delete(room.code);
    for (const [socket, binding] of this.bindings) {
      if (binding.room !== room) continue;
      this.bindings.delete(socket);
      if (this.accountSockets.get(binding.player.account) === socket) {
        this.accountSockets.delete(binding.player.account);
      }
    }
  }

  /** Dừng mọi timer khi đóng server (test không bị treo). */
  dispose(): void {
    for (const room of this.rooms.values()) this.clearAllTimers(room);
    this.rooms.clear();
    this.bindings.clear();
    this.accountSockets.clear();
  }

  private sendRoom(room: Room, player: RoomPlayer): void {
    if (!player.socket) return;
    this.send(player.socket, { t: 'room', room: this.publicRoom(room, player) });
  }

  private broadcastRoom(room: Room): void {
    for (const player of room.players) {
      if (player.socket) this.sendRoom(room, player);
    }
  }

  private broadcastState(room: Room): void {
    for (const player of room.players) this.sendState(room, player);
  }

  private sendState(room: Room, player: RoomPlayer, options: { includeLog?: boolean } = {}): void {
    if (!player.socket || player.socket.readyState !== 1) return;
    this.send(player.socket, {
      t: 'state',
      you: { seat: player.seat, hand: this.handOf(room, player) },
      state: this.publicState(room),
      ...(options.includeLog ? { actionLog: this.publicActionLog(room) } : {}),
    });
  }

  /** Log công khai từ đầu ván, không chứa seed/hand của bất kỳ ai. */
  private publicActionLog(room: Room): readonly ActionLogView[] {
    const history = room.game?.history ?? [];
    const log: ActionLogView[] = [];
    for (const entry of history) {
      switch (entry.type) {
        case 'play':
          log.push({
            actionId: entry.actionId,
            seat: entry.seat,
            type: 'play',
            cards: entry.cards.map(toCardView),
            auto: entry.auto === true,
          });
          break;
        case 'pass':
          log.push({
            actionId: entry.actionId,
            seat: entry.seat,
            type: 'pass',
            cards: [],
            auto: entry.auto,
          });
          break;
        case 'chop':
          log.push({
            actionId: entry.actionId,
            seat: entry.seat,
            type: 'chop',
            cards: entry.cards.map(toCardView),
            auto: false,
            targetActionId: entry.targetActionId,
          });
          break;
        case 'surrender':
          log.push({
            actionId: entry.actionId,
            seat: entry.seat,
            type: 'surrender',
            cards: [],
            auto: false,
          });
          break;
      }
    }
    return log;
  }

  private handOf(room: Room, player: RoomPlayer): readonly CardView[] {
    const gamePlayer = room.game?.players[player.seat];
    if (!gamePlayer) return [];
    return gamePlayer.hand.map(toCardView);
  }

  private publicRoom(room: Room, viewer: RoomPlayer): RoomView {
    return {
      code: room.code,
      hostSeat: room.hostSeat,
      maxSeats: MAX_SEATS,
      phase: room.phase,
      players: room.players
        .slice()
        .sort((a, b) => a.seat - b.seat)
        .map((player) => ({
          seat: player.seat,
          nickname: player.nickname,
          ready: player.ready,
          connected: player.connected,
          isHost: player.seat === room.hostSeat,
        })),
      you: { seat: viewer.seat, token: viewer.token },
    };
  }

  private publicState(room: Room): PublicGameState {
    const game = room.game;
    if (!game) {
      return {
        rulesVersion: rules.rulesVersion,
        phase: room.phase,
        turn: -1,
        players: room.players.map((player) => ({
          seat: player.seat,
          nickname: player.nickname,
          cardsLeft: 0,
          ready: player.ready,
          connected: player.connected,
          surrendered: false,
        })),
        table: null,
        trick: { id: 0, leader: -1, passed: [] },
        ranking: null,
        scores: null,
        turnDeadline: null,
        chopWindow: null,
        lastActionId: null,
        serverNow: Date.now(),
      };
    }

    const table: TableView | null = game.trick.lastPlay
      ? {
          cards: game.trick.lastPlay.cards.map(toCardView),
          seat: game.trick.lastPlay.seat,
          actionId: game.trick.lastPlay.actionId,
          comboKind: game.trick.lastPlay.combo.kind,
          comboSize: game.trick.lastPlay.combo.size,
        }
      : null;

    const ranking: RankingView[] | null =
      game.phase === 'finished'
        ? game.ranking.map((entry) => ({
            seat: entry.seat,
            place: entry.place,
            cardsLeft: entry.cardsLeft,
          }))
        : null;

    const score = game.phase === 'finished' ? calculateScore(game) : null;
    const scores = score?.deltas ?? null;

    const chopWindow: ChopWindowView | null = game.chopWindow
      ? {
          openAt: game.chopWindow.openAt,
          closesAt: game.chopWindow.closesAt,
          targetActionId: game.chopWindow.targetActionId,
          targetCards: game.chopWindow.targetCards.map(toCardView),
          targetBy: game.chopWindow.targetBy,
        }
      : null;

    return {
      rulesVersion: rules.rulesVersion,
      phase: room.phase,
      turn: game.turn,
      players: room.players
        .slice()
        .sort((a, b) => a.seat - b.seat)
        .map((player) => {
          const gamePlayer = game.players[player.seat];
          return {
            seat: player.seat,
            nickname: player.nickname,
            cardsLeft: gamePlayer?.hand.length ?? 0,
            ready: player.ready,
            connected: player.connected,
            surrendered: gamePlayer?.surrendered ?? false,
          };
        }),
      table,
      trick: { id: game.trick.id, leader: game.trick.leader, passed: [...game.trick.passed] },
      ranking,
      scores,
      ...(score ? { breakdown: score.breakdown } : {}),
      turnDeadline: room.turnDeadline,
      chopWindow,
      lastActionId: game.lastActionId,
      serverNow: Date.now(),
    };
  }

  private sendError(socket: WebSocket, code: string, message: string): void {
    this.send(socket, { t: 'error', code, message });
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify(message));
    }
  }

  get roomCount(): number {
    return this.rooms.size;
  }
}
