import { randomInt, randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { rules } from '../src/data/index';
import {
  applyIntent,
  applyTimeout,
  calculateScore,
  createRoundGame,
  resolveFirstSeat,
  thoiPoints,
  type GameRulesInput,
  type GameState,
  type Intent,
  type Place,
  type Placement,
} from '../src/rules/index';
import type { Card } from '../src/rules/types';
import type { AuthedSocket, Principal } from './auth/principal';
import type { GameStore } from './db';
import {
  MAX_SEATS,
  MAX_SPECTATORS,
  MIN_SEATS,
  NICKNAME_MAX,
  ROOM_CODE_LENGTH,
  parseClientMessage,
  type ActionLogView,
  type CardView,
  type ChopWindowView,
  type ClientMessage,
  type DenBaiView,
  type PublicGameState,
  type RankingView,
  type RoomPhase,
  type RoomSummaryView,
  type RoomView,
  type ServerMessage,
  type TableView,
  type TourEndRowView,
  type TourEndView,
  type TourPausedView,
  type TourPhase,
  type TourRankPlace,
  type TourResultView,
  type TourScoreView,
  type TourView,
} from '../src/net/protocol';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULT_MAX_ROOMS = 500;
/** Message mà khán giả không được gửi (doc-5 §4.2). */
const SPECTATOR_BLOCKED: ReadonlySet<ClientMessage['t']> = new Set([
  'ready',
  'start',
  'play',
  'pass',
  'surrender',
  'chop',
  'leaveTour',
  'endTour',
  'newTour',
]);
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
  /** Thời gian hiện bảng điểm ván trước khi auto chia ván mới (ms), mặc định `rules.tour.resultDisplayMs`. */
  readonly tourResultDisplayMs?: number;
  /** Đếm ngược khi tour resume từ TAM_DUNG (ms), mặc định `rules.tour.resumeCountdownMs`. */
  readonly tourResumeMs?: number;
  /** Số người tối thiểu để chia ván (mặc định `rules.tour.minPlayersToStart`). */
  readonly minPlayersToStart?: number;
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
  /** doc-4 §6: đã rời tour, ghế trống cho người mới; điểm tour không bảo lưu khi quay lại. */
  left: boolean;
  socket: WebSocket | null;
}

/** doc-4 §5.2: điểm tour cộng dồn của 1 người trong tour hiện tại. */
interface TourScore {
  readonly account: string;
  nickname: string;
  seat: number;
  joinedMid: boolean;
  left: boolean;
  pointsTotal: number;
  wins: number;
  chatThu: number;
  chatTra: number;
  thoiTra: number;
  denTra: number;
  roundsPlayed: number;
  /** Điểm ván vừa kết thúc; reset đầu mỗi ván. */
  roundPoints: number;
  lastPlace: Place | null;
}

type Binding =
  | { readonly room: Room; readonly role: 'player'; readonly player: RoomPlayer }
  | { readonly room: Room; readonly role: 'spectator'; readonly spectator: RoomSpectator };

/** Khán giả: không ghế, không bài, token reconnect riêng (doc-5 §4). */
interface RoomSpectator {
  readonly account: string;
  readonly nickname: string;
  readonly token: string;
  socket: WebSocket | null;
  connected: boolean;
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
  readonly spectators: RoomSpectator[] = [];
  readonly rateHits: number[] = [];
  turnTimer: NodeJS.Timeout | null = null;
  windowTimer: NodeJS.Timeout | null = null;
  cleanupTimer: NodeJS.Timeout | null = null;
  /** Timer auto chia ván mới (KET_QUA_VAN → VAN_(i+1)) hoặc resume từ TAM_DUNG. */
  tourTimer: NodeJS.Timeout | null = null;
  readonly graceTimers = new Map<number, NodeJS.Timeout>();
  readonly expiryTimers = new Map<number, NodeJS.Timeout>();

  // --- doc-4: state tour (server authoritative) ---
  tourId: string | null = null;
  soVan: number = rules.tour.defaultCount;
  /** Ván đã/đang chơi gần nhất, 1..N; 0 = chưa chia ván nào. */
  roundIndex = 0;
  tourPhase: TourPhase | null = null;
  tourIncomplete = false;
  /** Mốc auto chia ván mới / resume (epoch ms). */
  nextRoundAt: number | null = null;
  readonly tourScores = new Map<string, TourScore>();
  /** Hạng ván trước theo account (ghế có thể đổi khi compact lại). */
  readonly previousPlaces = new Map<string, Place>();
  /** Ghế đi trước + lượt đầu tự do của ván hiện tại (để ghi DB/replay). */
  matchFirstSeat = 0;
  matchFirstMoveFree = false;

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

/** Hạng tour theo thứ tự đã xếp (doc-4 §5.3). */
function turnRankPlace(rank: number): TourRankPlace {
  if (rank === 1) return 'nhat';
  if (rank === 2) return 'nhi';
  if (rank === 3) return 'ba';
  return 'bet';
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
  /** Mọi socket đã kết nối (kể cả chưa vào phòng) để push roomList cho sảnh. */
  private readonly sockets = new Set<WebSocket>();
  private roomListTimer: NodeJS.Timeout | null = null;

  constructor(private readonly config: RoomManagerConfig) {}

  handleConnection(socket: WebSocket): void {
    this.sockets.add(socket);
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
    const binding = this.bindings.get(socket);
    if (binding?.role === 'spectator' && SPECTATOR_BLOCKED.has(message.t)) {
      this.sendError(socket, 'FORBIDDEN_ROLE', 'khán giả không thể thực hiện hành động này');
      return;
    }
    switch (message.t) {
      case 'createRoom':
        this.createRoom(socket, message.soVan);
        return;
      case 'joinRoom':
        this.joinRoom(socket, message.code);
        return;
      case 'joinSeat':
        this.joinSeat(socket, message.code);
        return;
      case 'leaveWatch':
        this.leaveWatch(socket);
        return;
      case 'listRooms':
        this.sendRoomList(socket);
        return;
      case 'ready':
        this.setReady(socket, message.ready);
        return;
      case 'start':
        this.startGame(socket);
        return;
      case 'leaveTour':
        this.leaveTour(socket);
        return;
      case 'endTour':
        this.endTour(socket);
        return;
      case 'newTour':
        this.newTour(socket, message.soVan);
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

  private bindingOf(socket: WebSocket): Binding | null {
    return this.bindings.get(socket) ?? null;
  }

  private playerBindingOf(socket: WebSocket): { room: Room; player: RoomPlayer } | null {
    const binding = this.bindingOf(socket);
    return binding && binding.role === 'player'
      ? { room: binding.room, player: binding.player }
      : null;
  }

  /** Principal do server gắn lúc upgrade; null nghĩa là socket chưa xác thực. */
  private principalOf(socket: WebSocket): Principal | null {
    return (socket as AuthedSocket).principal ?? null;
  }

  /**
   * Đảm bảo một account chỉ giữ một ghế: đóng socket cũ (4001) trước khi socket mới vào phòng.
   * Trả false khi account đang ở phòng khác lobby — không cướp ghế giữa ván/tour,
   * nên không bao giờ tạo ghế mới đè lên ghế đang chơi.
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
    if (oldBinding.role === 'spectator') {
      // Đang xem phòng khác: nhường ngay, không ảnh hưởng ghế/ván.
      this.removeSpectator(oldBinding.room, oldBinding.spectator);
      this.bindings.delete(current);
      current.close(CLOSE_REPLACED, 'REPLACED');
      this.accountSockets.set(account, socket);
      return true;
    }
    if (oldBinding.room.phase === 'playing' || oldBinding.room.tourId !== null) {
      // Đang chơi / đang trong tour: không cướp ghế, không sắp lại ghế. Tab cũ phải thoát.
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
      // Khán giả còn lại về sảnh, giữ socket để nhận roomList mới.
      for (const spectator of [...room.spectators]) {
        const socket = spectator.socket;
        spectator.socket = null;
        spectator.connected = false;
        if (!socket) continue;
        this.bindings.delete(socket);
        if (this.accountSockets.get(spectator.account) === socket) {
          this.accountSockets.delete(spectator.account);
        }
        this.sendRoomList(socket);
      }
      room.spectators.length = 0;
      this.scheduleRoomList();
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

  private createRoom(socket: WebSocket, soVan?: number): void {
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
    const { min: tourMin, max: tourMax, defaultCount: tourDefault } = rules.tour;
    if (
      soVan !== undefined &&
      (!Number.isInteger(soVan) || soVan < tourMin || soVan > tourMax)
    ) {
      this.sendError(
        socket,
        'INVALID_TOUR_COUNT',
        `số ván phải là số nguyên từ ${tourMin} đến ${tourMax}`,
      );
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
    room.soVan = soVan ?? tourDefault;
    const player: RoomPlayer = {
      seat: 0,
      account,
      nickname,
      token: randomUUID(),
      userId: this.config.store?.createUser(nickname) ?? null,
      ready: false,
      connected: true,
      surrendered: false,
      left: false,
      socket,
    };
    room.players.push(player);
    room.hostSeat = 0;
    this.rooms.set(code, room);
    this.bindings.set(socket, { room, role: 'player', player });
    this.sendRoom(room, player);
    this.scheduleRoomList();
  }

  /** Tour đang trong vòng chơi (chưa tổng kết) — khoá ghế, không nhận người mới. */
  private isTourActive(room: Room): boolean {
    if (room.tourId === null) return false;
    if (room.phase === 'playing') return true;
    return (
      room.tourPhase === 'running' ||
      room.tourPhase === 'betweenRounds' ||
      room.tourPhase === 'paused'
    );
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
    const account = principal.username;
    if (room.players.some((player) => !player.left && player.account === account)) {
      // Không tạo ghế thứ hai cho cùng account; người có ghế phải reconnect bằng token.
      this.sendError(
        socket,
        'ALREADY_IN_GAME',
        'tài khoản đã có ghế trong phòng này, hãy reconnect bằng token',
      );
      return;
    }
    if (room.spectators.some((entry) => entry.account === account)) {
      this.sendError(
        socket,
        'ALREADY_IN_GAME',
        'tài khoản đang xem phòng này, hãy reconnect bằng token',
      );
      return;
    }
    const tourActive = this.isTourActive(room);
    // Tour đã tổng kết: phòng coi như sảnh chờ tour mới nên vẫn nhận người vào ghế trống.
    const tourFinished = room.tourId !== null && room.tourPhase === 'finished';
    const seatsOpen =
      room.phase === 'lobby' || tourFinished || (tourActive && rules.tour.allowMidJoin);
    if (!seatsOpen || this.firstFreeSeat(room) === null) {
      // Hết ghế / đang chơi / tour đang chạy: vào xem, không tạo ghế (doc-5 §4.1).
      this.addSpectator(socket, room, principal);
      return;
    }
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
      // claimAccount có thể vừa giải phóng/đổi ghế: kiểm tra lại rồi lùi về khán giả.
      this.addSpectator(socket, room, principal);
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
      left: false,
      socket,
    };
    room.players.push(player);
    this.bindings.set(socket, { room, role: 'player', player });
    if (room.tourId !== null && room.roundIndex > 0) {
      // Vào sau khi tour đã chơi ít nhất 1 ván (chỉ còn cửa sổ sau tổng kết): điểm từ 0,
      // cờ vào giữa tour, không kế thừa hạng ván trước.
      const entry = this.ensureTourScore(room, player);
      entry.joinedMid = true;
      entry.left = false;
      entry.pointsTotal = 0;
      entry.wins = 0;
      entry.chatThu = 0;
      entry.chatTra = 0;
      entry.thoiTra = 0;
      entry.denTra = 0;
      entry.roundsPlayed = 0;
      entry.roundPoints = 0;
      entry.lastPlace = null;
      this.maybeResumeTour(room);
    }
    this.sendRoom(room, player);
    this.broadcastRoom(room);
  }

  /** Vào xem: không ghế, không bài, token riêng để reconnect (tối đa MAX_SPECTATORS). */
  private addSpectator(socket: WebSocket, room: Room, principal: Principal): void {
    // Dọn slot của khán giả đã đóng socket để người mới không bị chặn oan.
    for (const stale of [...room.spectators]) {
      if (stale.connected) continue;
      this.removeSpectator(room, stale);
    }
    if (room.spectators.length >= MAX_SPECTATORS) {
      this.sendError(socket, 'ROOM_SPECTATOR_FULL', 'phòng đã đủ khán giả');
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
    const spectator: RoomSpectator = {
      account,
      nickname: nicknameOf(principal),
      token: randomUUID(),
      socket,
      connected: true,
    };
    room.spectators.push(spectator);
    this.bindings.set(socket, { room, role: 'spectator', spectator });
    this.cancelCleanup(room);
    this.sendRoom(room, spectator);
    this.broadcastRoom(room);
    if (room.game) this.sendState(room, spectator, { includeLog: true });
    this.sendTourSnapshot(room, spectator);
  }

  private removeSpectator(room: Room, spectator: RoomSpectator): void {
    const index = room.spectators.indexOf(spectator);
    if (index >= 0) room.spectators.splice(index, 1);
    const socket = spectator.socket;
    spectator.socket = null;
    spectator.connected = false;
    if (!socket) return;
    this.bindings.delete(socket);
    if (this.accountSockets.get(spectator.account) === socket) {
      this.accountSockets.delete(spectator.account);
    }
  }

  /** Khán giả xin vào ghế trống khi phòng còn mở (doc-5 §4.1, TS-09). */
  private joinSeat(socket: WebSocket, code: string): void {
    const binding = this.bindingOf(socket);
    if (!binding) {
      this.sendError(socket, 'NOT_IN_ROOM', 'chưa ở trong phòng');
      return;
    }
    if (binding.role !== 'spectator') {
      this.sendError(socket, 'FORBIDDEN_ROLE', 'chỉ khán giả mới dùng joinSeat');
      return;
    }
    const room = binding.room;
    if (room.code !== code) {
      this.sendError(socket, 'ROOM_MISMATCH', 'không phải phòng đang xem');
      return;
    }
    if (room.phase !== 'lobby' || this.isTourActive(room)) {
      this.sendError(socket, 'ROOM_NOT_LOBBY', 'phòng không còn chỗ cho người mới');
      return;
    }
    if (room.players.some((player) => !player.left && player.account === binding.spectator.account)) {
      this.sendError(socket, 'ALREADY_IN_GAME', 'tài khoản đã có ghế trong phòng');
      return;
    }
    const seat = this.firstFreeSeat(room);
    if (seat === null) {
      this.sendError(socket, 'ROOM_FULL', 'phòng đã đủ ghế');
      return;
    }
    const spectator = binding.spectator;
    const nickname = spectator.nickname;
    const player: RoomPlayer = {
      seat,
      account: spectator.account,
      nickname,
      token: randomUUID(),
      userId: this.config.store?.createUser(nickname) ?? null,
      ready: false,
      connected: true,
      surrendered: false,
      left: false,
      socket,
    };
    this.removeSpectator(room, spectator);
    room.players.push(player);
    this.bindings.set(socket, { room, role: 'player', player });
    this.sendRoom(room, player);
    this.broadcastRoom(room);
    if (room.game) this.sendState(room, player);
  }

  /** Khán giả tự rời phòng, giữ socket để quay lại sảnh. */
  private leaveWatch(socket: WebSocket): void {
    const binding = this.bindingOf(socket);
    if (!binding) {
      this.sendError(socket, 'NOT_IN_ROOM', 'chưa ở trong phòng');
      return;
    }
    if (binding.role !== 'spectator') {
      this.sendError(socket, 'FORBIDDEN_ROLE', 'chỉ khán giả mới dùng leaveWatch');
      return;
    }
    this.removeSpectator(binding.room, binding.spectator);
    this.broadcastRoom(binding.room);
    this.maybeScheduleCleanup(binding.room);
    this.sendRoomList(socket);
  }

  private firstFreeSeat(room: Room): number | null {
    for (let seat = 0; seat < MAX_SEATS; seat += 1) {
      if (!room.players.some((player) => !player.left && player.seat === seat)) return seat;
    }
    return null;
  }

  private setReady(socket: WebSocket, ready: boolean): void {
    const binding = this.playerBindingOf(socket);
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
    this.startTour(room, room.soVan);
  }

  private startGame(socket: WebSocket): void {
    const binding = this.playerBindingOf(socket);
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
    this.startTour(room, room.soVan);
  }

  /** doc-4 §3.1: chốt N → sinh `tour_id`, khóa số ván, chia VAN_1. */
  private startTour(room: Room, soVan: number): void {
    if (room.phase !== 'lobby') return;
    if (room.players.length < MIN_SEATS) return;
    const { min, max, defaultCount } = rules.tour;
    const total = Number.isInteger(soVan) && soVan >= min && soVan <= max ? soVan : defaultCount;
    const minPlayers = this.config.minPlayersToStart ?? rules.tour.minPlayersToStart;
    if (room.players.length < minPlayers) return;

    room.tourId = randomUUID();
    room.soVan = total;
    room.roundIndex = 0;
    room.tourIncomplete = false;
    room.tourPhase = 'running';
    room.nextRoundAt = null;
    this.clearTourTimer(room);
    room.tourScores.clear();
    room.previousPlaces.clear();
    for (const player of room.players) {
      player.left = false;
      player.ready = false;
      player.surrendered = false;
    }
    for (const player of room.players) this.ensureTourScore(room, player);
    this.config.store?.createTour({
      tourId: room.tourId,
      roomCode: room.code,
      totalRounds: total,
      createdBy: room.players.find((player) => player.seat === room.hostSeat)?.nickname ?? '',
    });
    this.startRoundInternal(room, 1);
  }

  /** Chia 1 ván của tour; ghế được compact lại theo đúng người còn trong phòng. */
  private startRoundInternal(room: Room, roundIndex: number): void {
    const minPlayers = this.config.minPlayersToStart ?? rules.tour.minPlayersToStart;
    this.dropLeftPlayers(room);
    const present = room.players.filter((player) => !player.left);
    if (present.length < minPlayers) {
      this.pauseTour(room);
      return;
    }
    present.sort((a, b) => a.seat - b.seat);
    const hostAccount = room.players.find((player) => player.seat === room.hostSeat)?.account;
    present.forEach((player, index) => {
      player.seat = index;
      player.ready = false;
      player.surrendered = false;
    });
    const resolvedHost = hostAccount
      ? present.find((player) => player.account === hostAccount)?.seat
      : undefined;
    room.hostSeat = resolvedHost ?? 0;
    room.rateHits.length = 0;

    const previousRanking: Placement[] = [];
    for (const player of present) {
      const place = room.previousPlaces.get(player.account);
      if (place) previousRanking.push({ seat: player.seat, place, cardsLeft: 0 });
    }

    const seed = this.config.seed ?? randomInt(1, 2_147_483_647);
    const round = createRoundGame({
      seed,
      players: present.length,
      rules: engineRules(this.config),
      roundIndex,
      previousRanking,
      presentSeats: present.map((player) => player.seat),
      hostSeat: room.hostSeat,
      ...(this.config.hands ? { hands: this.config.hands } : {}),
      ...(roundIndex === 1 && this.config.startingPlayerIndex !== undefined
        ? { startingPlayerIndex: this.config.startingPlayerIndex }
        : {}),
    });

    room.game = round.state;
    room.phase = round.state.phase === 'finished' ? 'finished' : 'playing';
    room.tourPhase = 'running';
    room.roundIndex = roundIndex;
    room.nextRoundAt = null;
    this.clearTourTimer(room);
    room.turnDeadline = null;
    room.actionSeq = 0;
    room.resultRecorded = false;
    room.matchFirstSeat = round.firstSeat;
    room.matchFirstMoveFree = round.firstMoveFree;
    room.matchId =
      this.config.store?.createMatch({
        roomCode: room.code,
        seed,
        rulesVersion: rules.rulesVersion,
        config: {
          windowMs: this.config.windowMs,
          turnMs: this.config.turnMs,
          roundIndex,
          firstSeat: round.firstSeat,
          firstMoveFree: round.firstMoveFree,
        },
        players: present.map((player) => ({
          seat: player.seat,
          nickname: player.nickname,
          userId: player.userId,
        })),
        tourId: room.tourId,
        roundIndex,
      }) ?? null;
    for (const entry of room.tourScores.values()) {
      entry.roundPoints = 0;
      entry.lastPlace = null;
    }
    this.broadcastRoom(room);
    this.syncTimers(room);
    this.broadcastState(room);
    if (room.phase === 'finished') {
      // Tới trắng ngay sau chia: quyết toán luôn như ván đã kết thúc.
      this.persistResult(room);
      this.recordTourRound(room);
      this.publishRoundEnd(room);
    }
  }

  private handleIntent(
    socket: WebSocket,
    message: Extract<ClientMessage, { t: 'play' | 'pass' | 'surrender' | 'chop' }>,
  ): void {
    const binding = this.playerBindingOf(socket);
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
    const previous = room.game;
    room.game = state;
    const denEvents = this.newDenBaiEvents(previous, state);
    const justFinished = state.phase === 'finished' && previous?.phase !== 'finished';
    if (justFinished) {
      room.phase = 'finished';
      room.turnDeadline = null;
      this.clearAllTimers(room);
      this.persistResult(room);
      this.recordTourRound(room);
    }
    this.syncTimers(room);
    this.broadcastState(room);
    for (const event of denEvents) this.broadcastDenBai(room, event);
    if (justFinished) {
      this.broadcastRoom(room);
      this.publishRoundEnd(room);
    }
  }

  /** Ghế vừa chuyển sang denOut sau action này (engine đã chốt đền). */
  private newDenBaiEvents(
    previous: GameState | null,
    next: GameState,
  ): readonly DenBaiView[] {
    if (!previous) return [];
    const to = next.ranking.find((entry) => entry.place === 'nhat')?.seat;
    if (to === undefined) return [];
    const events: DenBaiView[] = [];
    for (const player of next.players) {
      if (player.denOut !== true) continue;
      if (previous.players[player.seat]?.denOut === true) continue;
      events.push({
        who: player.seat,
        to,
        points: this.denBaiPoints(next, player.seat),
        reason: 'GIU_13_LA',
      });
    }
    return events;
  }

  /** Cùng công thức scoring.ts: `den.giu13La` + giá trị heo/hàng còn trên tay. */
  private denBaiPoints(game: GameState, seat: number): number {
    const player = game.players[seat];
    if (!player) return 0;
    return (
      game.rules.scoring.den.giu13La +
      thoiPoints(player.hand, game.order, game.rules.scoring.values)
    );
  }

  /** Toàn bộ ghế đền của ván (cho state/reconnect), rỗng khi chưa có Nhất. */
  private denBaiViews(game: GameState): readonly DenBaiView[] {
    const to = game.ranking.find((entry) => entry.place === 'nhat')?.seat;
    if (to === undefined) return [];
    return game.players
      .filter((player) => player.denOut === true)
      .map((player) => ({
        who: player.seat,
        to,
        points: this.denBaiPoints(game, player.seat),
        reason: 'GIU_13_LA' as const,
      }));
  }

  /** Ghế đã chốt hạng (về Nhất/Nhì/Ba/Bét hoặc xin hàng) — không còn quyền đánh. */
  private isPlaced(game: GameState, seat: number): boolean {
    return game.ranking.some((entry) => entry.seat === seat);
  }

  /** Ghế còn thực sự trong ván: chưa xếp hạng, chưa rời, còn bài. */
  private canAct(game: GameState, seat: number): boolean {
    if (game.phase !== 'playing') return false;
    if (!Number.isInteger(seat) || seat < 0 || seat >= game.players.length) return false;
    const player = game.players[seat];
    if (!player) return false;
    // rev6 §1.7: ghế đền 13 lá đã ra khỏi ván — không lượt, không timeout/grace.
    if (player.denOut === true) return false;
    if (player.surrendered || player.hand.length === 0) return false;
    return !this.isPlaced(game, seat);
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
    // §1.7: không bao giờ hẹn giờ cho ghế đã hết bài/đã về — auto sẽ bắn nhầm.
    if (!this.canAct(room.game, room.game.turn)) {
      room.turnDeadline = null;
      room.turnRemainingMs = null;
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
    // Ghế tới lượt vừa hết bài/rời trước khi timer chạy: bỏ qua, không auto cho ghế đó.
    if (!this.canAct(game, game.turn)) {
      this.syncTimers(room);
      return;
    }
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

  /** Lấy/tạo bản ghi điểm tour cho 1 người (khoá theo account, không theo ghế). */
  private ensureTourScore(room: Room, player: RoomPlayer): TourScore {
    const existing = room.tourScores.get(player.account);
    if (existing) {
      existing.nickname = player.nickname;
      existing.seat = player.seat;
      return existing;
    }
    const entry: TourScore = {
      account: player.account,
      nickname: player.nickname,
      seat: player.seat,
      joinedMid: room.roundIndex > 0,
      left: false,
      pointsTotal: 0,
      wins: 0,
      chatThu: 0,
      chatTra: 0,
      thoiTra: 0,
      denTra: 0,
      roundsPlayed: 0,
      roundPoints: 0,
      lastPlace: null,
    };
    room.tourScores.set(player.account, entry);
    return entry;
  }

  /** doc-4 §5.1: cộng điểm ván vào điểm tour + thống kê chặt/thối/đền + hạng ván trước. */
  private recordTourRound(room: Room): void {
    const game = room.game;
    if (!game || game.phase !== 'finished') return;
    const score = calculateScore(game);
    const bySeat = new Map<number, RoomPlayer>();
    for (const player of room.players) bySeat.set(player.seat, player);
    for (const entry of room.tourScores.values()) {
      entry.roundPoints = 0;
      entry.lastPlace = null;
    }

    const winnerSeat = game.ranking.find((entry) => entry.place === 'nhat')?.seat ?? null;
    for (const player of room.players) {
      if (player.left) continue;
      const entry = this.ensureTourScore(room, player);
      const delta = score.deltas[player.seat] ?? 0;
      entry.roundPoints = delta;
      entry.pointsTotal += delta;
      entry.roundsPlayed += 1;
      entry.lastPlace = game.ranking.find((row) => row.seat === player.seat)?.place ?? null;
      if (winnerSeat === player.seat) entry.wins += 1;
    }

    for (const row of score.breakdown) {
      if (row.type === 'chop' || row.type === 'chatChong') {
        const payer = row.from === null ? undefined : bySeat.get(row.from);
        if (payer) this.ensureTourScore(room, payer).chatTra += row.points;
        const receiver = row.to === null ? undefined : bySeat.get(row.to);
        if (receiver) this.ensureTourScore(room, receiver).chatThu += row.points;
      } else if (row.type === 'thoi') {
        const payer = row.from === null ? undefined : bySeat.get(row.from);
        if (payer) this.ensureTourScore(room, payer).thoiTra += row.points;
      } else if (row.type === 'denGiu13La') {
        const payer = row.from === null ? undefined : bySeat.get(row.from);
        if (payer) this.ensureTourScore(room, payer).denTra += row.points;
      }
    }

    room.previousPlaces.clear();
    for (const row of game.ranking) {
      const player = bySeat.get(row.seat);
      if (player) room.previousPlaces.set(player.account, row.place);
    }

    if (room.tourId === null) return;
    const tourId = room.tourId;
    for (const entry of room.tourScores.values()) {
      this.config.store?.upsertTourScore({
        tourId,
        account: entry.account,
        nickname: entry.nickname,
        seat: this.liveSeatOf(room, entry),
        pointsTotal: entry.pointsTotal,
        wins: entry.wins,
        chatThu: entry.chatThu,
        chatTra: entry.chatTra,
        thoiTra: entry.thoiTra,
        denTra: entry.denTra,
        roundsPlayed: entry.roundsPlayed,
        joinedMid: entry.joinedMid,
        leftMid: entry.left,
      });
    }
  }

  private liveSeatOf(room: Room, entry: TourScore): number {
    return room.players.find((player) => player.account === entry.account)?.seat ?? entry.seat;
  }

  /** doc-4 §5.3: tổng điểm → số ván Nhất → (thối+đền) ít hơn → ghế nhỏ hơn. */
  private rankedTourScores(room: Room): TourScore[] {
    return [...room.tourScores.values()]
      .filter((entry) => entry.roundsPlayed > 0 || entry.joinedMid || entry.left)
      .sort((a, b) => {
        if (b.pointsTotal !== a.pointsTotal) return b.pointsTotal - a.pointsTotal;
        if (b.wins !== a.wins) return b.wins - a.wins;
        const paidA = a.thoiTra + a.denTra;
        const paidB = b.thoiTra + b.denTra;
        if (paidA !== paidB) return paidA - paidB;
        return this.liveSeatOf(room, a) - this.liveSeatOf(room, b);
      });
  }

  private tourScoreView(room: Room, entry: TourScore): TourScoreView {
    return {
      seat: this.liveSeatOf(room, entry),
      nickname: entry.nickname,
      pointsTotal: entry.pointsTotal,
      roundPoints: entry.roundPoints,
      wins: entry.wins,
      chatThu: entry.chatThu,
      chatTra: entry.chatTra,
      netChat: entry.chatThu - entry.chatTra,
      thoiTra: entry.thoiTra,
      denTra: entry.denTra,
      roundsPlayed: entry.roundsPlayed,
      joinedMid: entry.joinedMid,
      left: entry.left,
      lastPlace: entry.lastPlace,
    };
  }

  /** Ghế chủ phòng sau khi compact ghế (dùng cho fallback luật đi trước). */
  private compactHostSeat(room: Room, present: readonly RoomPlayer[]): number {
    const host = room.players.find((player) => player.seat === room.hostSeat);
    if (!host) return 0;
    const index = present.findIndex((player) => player.account === host.account);
    return index >= 0 ? index : 0;
  }

  /** Dự đoán "Nhất: <tên> đi trước ván tới" cho overlay KET_QUA_VAN. */
  private nextFirstInfo(room: Room): {
    seat: number | null;
    nickname: string | null;
    firstMoveFree: boolean;
  } {
    const minPlayers = this.config.minPlayersToStart ?? rules.tour.minPlayersToStart;
    const present = room.players
      .filter((player) => !player.left)
      .slice()
      .sort((a, b) => a.seat - b.seat);
    if (present.length < minPlayers) return { seat: null, nickname: null, firstMoveFree: false };
    const compacted = present.map((player, index) => ({ player, seat: index }));
    const previousRanking: Placement[] = [];
    for (const entry of compacted) {
      const place = room.previousPlaces.get(entry.player.account);
      if (place) previousRanking.push({ seat: entry.seat, place, cardsLeft: 0 });
    }
    const resolution = resolveFirstSeat({
      roundIndex: room.roundIndex + 1,
      playerCount: compacted.length,
      previousRanking,
      presentSeats: compacted.map((entry) => entry.seat),
      hostSeat: this.compactHostSeat(room, present),
      config: rules.firstPlayerSubsequent,
    });
    const target = compacted.find((entry) => entry.seat === resolution.firstSeat);
    return {
      seat: resolution.firstSeat,
      nickname: target?.player.nickname ?? null,
      firstMoveFree: resolution.firstMoveFree,
    };
  }

  private buildTourResult(room: Room): ServerMessage {
    const next = this.nextFirstInfo(room);
    const result: TourResultView = {
      tourId: room.tourId ?? '',
      roundIndex: room.roundIndex,
      soVan: room.soVan,
      nextRoundIndex: room.roundIndex < room.soVan ? room.roundIndex + 1 : null,
      nextRoundAt: room.nextRoundAt,
      nextFirstSeat: next.seat,
      nextFirstNickname: next.nickname,
      nextFirstMoveFree: next.firstMoveFree,
      scores: this.rankedTourScores(room).map((entry) => this.tourScoreView(room, entry)),
    };
    return { t: 'tourResult', result, serverNow: Date.now() };
  }

  private broadcastTourResult(room: Room): void {
    const message = this.buildTourResult(room);
    for (const player of room.players) {
      if (player.socket) this.send(player.socket, message);
    }
    for (const spectator of room.spectators) {
      if (spectator.socket) this.send(spectator.socket, message);
    }
  }

  /** Reconnect vào phòng đang ở giữa tour: dựng lại overlay đúng trạng thái. */
  private sendTourSnapshot(room: Room, viewer: RoomPlayer | RoomSpectator): void {
    if (!viewer.socket || room.tourId === null) return;
    if (room.tourPhase === 'betweenRounds' || room.tourPhase === 'paused') {
      if (room.roundIndex > 0) this.send(viewer.socket, this.buildTourResult(room));
      if (room.tourPhase === 'paused') this.send(viewer.socket, this.buildTourPaused(room));
      return;
    }
    if (room.tourPhase === 'finished') this.send(viewer.socket, this.buildTourEnd(room));
  }

  private buildTourPaused(room: Room): ServerMessage {
    const minPlayers = this.config.minPlayersToStart ?? rules.tour.minPlayersToStart;
    const paused: TourPausedView = {
      tourId: room.tourId ?? '',
      roundIndex: room.roundIndex,
      present: room.players.filter((player) => !player.left).length,
      needed: minPlayers,
      reason: 'thieu_nguoi',
    };
    return { t: 'tourPaused', paused, serverNow: Date.now() };
  }

  private buildTourEnd(room: Room): ServerMessage {
    const ranked = this.rankedTourScores(room);
    const rows: TourEndRowView[] = ranked.map((entry, index) => ({
      ...this.tourScoreView(room, entry),
      tourRank: index + 1,
      tourPlace: turnRankPlace(index + 1),
    }));
    const summary: TourEndView = {
      tourId: room.tourId ?? '',
      soVan: room.soVan,
      roundsPlayed: room.roundIndex,
      incomplete: room.tourIncomplete,
      rows,
    };
    return { t: 'tourEnd', summary, serverNow: Date.now() };
  }

  /**
   * doc-4 §3.1: ván vừa xong → giữ phòng, phát bảng điểm + điểm tour, hẹn auto ván mới
   * (hoặc TAM_DUNG khi thiếu người / TONG_KET_TOUR khi đủ N ván).
   */
  private publishRoundEnd(room: Room): void {
    if (room.tourId === null) {
      this.maybeScheduleCleanup(room);
      return;
    }
    if (room.roundIndex >= room.soVan) {
      this.finishTour(room, false);
      return;
    }
    const minPlayers = this.config.minPlayersToStart ?? rules.tour.minPlayersToStart;
    const present = room.players.filter((player) => !player.left).length;
    if (present < minPlayers) {
      this.pauseTour(room);
      return;
    }
    const delay = this.config.tourResultDisplayMs ?? rules.tour.resultDisplayMs;
    room.tourPhase = 'betweenRounds';
    room.nextRoundAt = Date.now() + delay;
    this.broadcastTourResult(room);
    this.broadcastRoom(room);
    const expectedAt = room.nextRoundAt;
    this.clearTourTimer(room);
    room.tourTimer = setTimeout(() => {
      room.tourTimer = null;
      if (this.rooms.get(room.code) !== room) return;
      if (room.tourPhase !== 'betweenRounds' || room.nextRoundAt !== expectedAt) return;
      // Không còn ai kết nối: không chia bài cho ghế ma, chuyển TAM_DUNG + dọn theo TTL.
      if (!room.players.some((player) => player.connected && !player.left)) {
        this.pauseTour(room);
        return;
      }
      this.startRoundInternal(room, room.roundIndex + 1);
    }, delay);
  }

  /** doc-4 §6: TAM_DUNG — chưa chia ván mới, chờ đủ người. */
  private pauseTour(room: Room): void {
    if (room.tourId === null) return;
    this.clearTourTimer(room);
    room.tourPhase = 'paused';
    room.nextRoundAt = null;
    room.phase = 'finished';
    const message = this.buildTourPaused(room);
    for (const player of room.players) {
      if (player.socket) this.send(player.socket, message);
    }
    for (const spectator of room.spectators) {
      if (spectator.socket) this.send(spectator.socket, message);
    }
    this.broadcastRoom(room);
    this.maybeScheduleCleanup(room);
  }

  /** TAM_DUNG → đếm ngược 3s → VAN_(i+1) khi đã đủ người. */
  private maybeResumeTour(room: Room): void {
    if (room.tourId === null || room.tourPhase !== 'paused') return;
    const minPlayers = this.config.minPlayersToStart ?? rules.tour.minPlayersToStart;
    if (room.players.filter((player) => !player.left).length < minPlayers) return;
    const delay = this.config.tourResumeMs ?? rules.tour.resumeCountdownMs;
    room.tourPhase = 'betweenRounds';
    room.nextRoundAt = Date.now() + delay;
    this.broadcastRoom(room);
    const expectedAt = room.nextRoundAt;
    this.clearTourTimer(room);
    room.tourTimer = setTimeout(() => {
      room.tourTimer = null;
      if (this.rooms.get(room.code) !== room) return;
      if (room.tourPhase !== 'betweenRounds' || room.nextRoundAt !== expectedAt) return;
      if (!room.players.some((player) => player.connected && !player.left)) {
        this.pauseTour(room);
        return;
      }
      this.startRoundInternal(room, room.roundIndex + 1);
    }, delay);
  }

  /** doc-4 §3.1: đủ N ván (hoặc chủ phòng dừng sớm) → bảng tổng kết, dừng auto. */
  private finishTour(room: Room, incomplete: boolean): void {
    this.clearTourTimer(room);
    room.tourPhase = 'finished';
    room.tourIncomplete = incomplete;
    room.nextRoundAt = null;
    room.phase = 'finished';
    if (room.tourId !== null) {
      this.config.store?.finishTour(
        room.tourId,
        incomplete ? 'incomplete' : 'finished',
        room.roundIndex,
      );
    }
    const ranked = this.rankedTourScores(room);
    const rows: TourEndRowView[] = ranked.map((entry, index) => ({
      ...this.tourScoreView(room, entry),
      tourRank: index + 1,
      tourPlace: turnRankPlace(index + 1),
    }));
    const summary: TourEndView = {
      tourId: room.tourId ?? '',
      soVan: room.soVan,
      roundsPlayed: room.roundIndex,
      incomplete,
      rows,
    };
    const message: ServerMessage = { t: 'tourEnd', summary, serverNow: Date.now() };
    for (const player of room.players) {
      if (player.socket) this.send(player.socket, message);
    }
    for (const spectator of room.spectators) {
      if (spectator.socket) this.send(spectator.socket, message);
    }
    this.broadcastRoom(room);
    this.maybeScheduleCleanup(room);
  }
  /**
   * doc-4 §6: rời tour → ghế trống ngay, điểm tour của họ không bảo lưu khi quay lại;
   * bảng tổng kết vẫn liệt kê với cờ `left`.
   */
  private releaseSeat(room: Room, player: RoomPlayer): void {
    if (player.left) return;
    player.left = true;
    const entry = room.tourScores.get(player.account);
    if (entry) {
      entry.left = true;
      if (room.tourId !== null) {
        this.config.store?.upsertTourScore({
          tourId: room.tourId,
          account: entry.account,
          nickname: entry.nickname,
          seat: entry.seat,
          pointsTotal: entry.pointsTotal,
          wins: entry.wins,
          chatThu: entry.chatThu,
          chatTra: entry.chatTra,
          thoiTra: entry.thoiTra,
          denTra: entry.denTra,
          roundsPlayed: entry.roundsPlayed,
          joinedMid: entry.joinedMid,
          leftMid: true,
        });
      }
    }
    if (room.hostSeat === player.seat) {
      const nextHost = room.players.find((other) => other !== player && !other.left);
      room.hostSeat = nextHost?.seat ?? 0;
    }
    // Giữ player + socket tới hết ván để họ vẫn nhận bảng điểm/tổng kết; ghế thực sự
    // được giải phóng ở `dropLeftPlayers` khi chia ván kế tiếp.
    player.connected = false;
    this.broadcastRoom(room);
    if (room.phase === 'playing') return;
    if (room.tourId === null) return;
    const minPlayers = this.config.minPlayersToStart ?? rules.tour.minPlayersToStart;
    if (room.players.filter((other) => !other.left).length < minPlayers) {
      if (room.tourPhase !== 'finished') this.pauseTour(room);
      return;
    }
    this.maybeResumeTour(room);
  }

  /** Bỏ hẳn người đã rời khỏi danh sách ghế trước khi chia ván mới. */
  private dropLeftPlayers(room: Room): void {
    for (const player of [...room.players]) {
      if (!player.left) continue;
      const index = room.players.indexOf(player);
      if (index >= 0) room.players.splice(index, 1);
      const socket = player.socket;
      if (socket) {
        this.bindings.delete(socket);
        if (this.accountSockets.get(player.account) === socket) {
          this.accountSockets.delete(player.account);
        }
      }
      player.socket = null;
    }
  }

  private leaveTour(socket: WebSocket): void {
    const binding = this.playerBindingOf(socket);
    if (!binding) {
      this.sendError(socket, 'NOT_IN_ROOM', 'chưa ở trong phòng');
      return;
    }
    const { room, player } = binding;
    if (room.tourId === null) {
      this.sendError(socket, 'NO_TOUR', 'phòng chưa mở tour');
      return;
    }
    this.markLeft(room, player);
    this.releaseSeat(room, player);
    this.maybeScheduleCleanup(room);
  }

  private endTour(socket: WebSocket): void {
    const binding = this.playerBindingOf(socket);
    if (!binding) {
      this.sendError(socket, 'NOT_IN_ROOM', 'chưa ở trong phòng');
      return;
    }
    const { room, player } = binding;
    if (room.tourId === null) {
      this.sendError(socket, 'NO_TOUR', 'phòng chưa mở tour');
      return;
    }
    if (!rules.tour.earlyEndByHost) {
      this.sendError(socket, 'EARLY_END_DISABLED', 'kết thúc sớm đang tắt');
      return;
    }
    if (player.seat !== room.hostSeat) {
      this.sendError(socket, 'NOT_HOST', 'chỉ chủ phòng được kết thúc sớm');
      return;
    }
    if (room.tourPhase !== 'betweenRounds' && room.tourPhase !== 'paused') {
      this.sendError(socket, 'TOUR_NOT_PAUSED', 'chỉ kết thúc sớm khi giữa các ván');
      return;
    }
    this.finishTour(room, true);
  }

  /** doc-4 §3.1: TONG_KET_TOUR → tour mới cùng ghế, điểm từ 0, `tour_id` mới. */
  private newTour(socket: WebSocket, soVan?: number): void {
    const binding = this.playerBindingOf(socket);
    if (!binding) {
      this.sendError(socket, 'NOT_IN_ROOM', 'chưa ở trong phòng');
      return;
    }
    const { room, player } = binding;
    if (room.tourId === null || room.tourPhase !== 'finished') {
      this.sendError(socket, 'TOUR_NOT_FINISHED', 'chỉ tạo tour mới sau khi tổng kết');
      return;
    }
    if (player.seat !== room.hostSeat) {
      this.sendError(socket, 'NOT_HOST', 'chỉ chủ phòng được mở tour mới');
      return;
    }
    const minPlayers = this.config.minPlayersToStart ?? rules.tour.minPlayersToStart;
    if (room.players.filter((other) => !other.left).length < minPlayers) {
      this.sendError(socket, 'NOT_ENOUGH_PLAYERS', 'cần ít nhất 2 người');
      return;
    }
    const { min, max } = rules.tour;
    const total =
      typeof soVan === 'number' && Number.isInteger(soVan) && soVan >= min && soVan <= max
        ? soVan
        : room.soVan;
    room.phase = 'lobby';
    room.tourPhase = null;
    room.tourId = null;
    room.roundIndex = 0;
    room.game = null;
    room.matchId = null;
    this.startTour(room, total);
  }

  private clearTourTimer(room: Room): void {
    if (!room.tourTimer) return;
    clearTimeout(room.tourTimer);
    room.tourTimer = null;
  }

  private tourView(room: Room): TourView {
    return {
      tourId: room.tourId ?? '',
      soVan: room.soVan,
      roundIndex: room.roundIndex,
      phase: room.tourPhase ?? 'running',
      nextRoundAt: room.nextRoundAt,
      ...(room.tourIncomplete ? { incomplete: true } : {}),
    };
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
    let found:
      | { readonly room: Room; readonly player: RoomPlayer }
      | { readonly room: Room; readonly spectator: RoomSpectator }
      | null = null;
    for (const room of this.rooms.values()) {
      const player = room.players.find((entry) => entry.token === token);
      if (player) {
        found = { room, player };
        break;
      }
      const spectator = room.spectators.find((entry) => entry.token === token);
      if (spectator) {
        found = { room, spectator };
        break;
      }
    }
    if (!found) {
      this.sendError(socket, 'INVALID_TOKEN', 'token không khớp phòng/ván nào');
      return;
    }
    const account = principal.username;
    const room = found.room;
    const ownAccount = 'player' in found ? found.player.account : found.spectator.account;
    if (ownAccount !== account) {
      // Token là bí mật của người khác: không chiếm chỗ, không đóng socket của họ.
      this.sendError(socket, 'INVALID_TOKEN', 'token không thuộc tài khoản này');
      return;
    }
    if ('player' in found) {
      const player = found.player;
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
        const otherAccount =
          binding.role === 'player' ? binding.player.account : binding.spectator.account;
        if (otherAccount !== account) continue;
        const same = binding.role === 'player' && binding.player === player;
        if (same) this.bindings.delete(other);
        other.close(CLOSE_REPLACED, 'REPLACED');
      }
      player.socket = socket;
      player.connected = true;
      this.bindings.set(socket, { room, role: 'player', player });
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
        for (const watcher of room.spectators) this.sendState(room, watcher);
      }
      this.sendTourSnapshot(room, player);
      return;
    }

    const spectator = found.spectator;
    const previous = spectator.socket;
    if (previous && previous !== socket) {
      this.bindings.delete(previous);
      previous.close(CLOSE_REPLACED, 'REPLACED');
    }
    for (const [other, binding] of this.bindings) {
      if (other === socket) continue;
      const otherAccount =
        binding.role === 'player' ? binding.player.account : binding.spectator.account;
      if (otherAccount !== account) continue;
      if (binding.role === 'spectator' && binding.spectator === spectator) {
        this.bindings.delete(other);
      }
      other.close(CLOSE_REPLACED, 'REPLACED');
    }
    spectator.socket = socket;
    spectator.connected = true;
    this.bindings.set(socket, { room, role: 'spectator', spectator });
    this.accountSockets.set(account, socket);
    this.cancelCleanup(room);
    this.sendRoom(room, spectator);
    this.broadcastRoom(room);
    if (room.game) this.sendState(room, spectator, { includeLog: true });
    this.sendTourSnapshot(room, spectator);
  }

  private handleClose(socket: WebSocket): void {
    this.sockets.delete(socket);
    const binding = this.bindings.get(socket);
    if (!binding) return;
    this.bindings.delete(socket);
    const room = binding.room;

    if (binding.role === 'spectator') {
      // Đóng socket: gỡ khỏi phòng (không ảnh hưởng ghế/tour) nhưng giữ token để
      // reconnect xem tiếp; slot khán giả được dọn khi hết hạn hoặc có người mới.
      const spectator = binding.spectator;
      if (this.accountSockets.get(spectator.account) === socket) {
        this.accountSockets.delete(spectator.account);
      }
      spectator.socket = null;
      spectator.connected = false;
      this.broadcastRoom(room);
      this.maybeScheduleCleanup(room);
      return;
    }

    const player = binding.player;
    if (this.accountSockets.get(player.account) === socket) {
      this.accountSockets.delete(player.account);
    }
    player.socket = null;
    player.connected = false;

    if (room.phase === 'lobby') {
      this.removeFromLobby(room, player);
      return;
    }

    // doc-4 §6: rời ở KET_QUA_VAN / TAM_DUNG / TONG_KET_TOUR → ghế trống ngay.
    if (room.tourId !== null && room.phase !== 'playing') {
      this.releaseSeat(room, player);
      this.maybeScheduleCleanup(room);
      return;
    }

    this.broadcastRoom(room);
    this.broadcastState(room);
    this.maybeScheduleCleanup(room);
    if (room.phase !== 'playing' || !room.game || room.game.phase !== 'playing') return;
    // Ghế đã về/hết bài: giữ nguyên token để còn reconnect xem kết quả, không xử thua.
    if (!this.canAct(room.game, player.seat)) return;
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
    if (room.tourId !== null) this.releaseSeat(room, player);
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
      // Ghế đã về (hết bài) thì không auto-pass/auto-play thay họ.
      if (!this.canAct(game, seat)) return;
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
      const game = room.game;
      // Ghế đã về hạng hoặc ván đã xong: giữ token reconnect để xem kết quả,
      // không biến họ thành "đã rời ván" sau khi đã chốt hạng.
      if (room.phase !== 'playing' || !game || game.phase !== 'playing') return;
      if (!this.canAct(game, seat)) return;
      // Quá hạn reconnect = rời ván vĩnh viễn. Set cờ TRƯỚC khi gọi engine để token
      // vẫn bị vô hiệu kể cả khi engine trả ALREADY_SURRENDERED / ván đã kết thúc.
      this.markLeft(room, player);
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
    this.clearTourTimer(room);
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
    if (room.spectators.some((spectator) => spectator.connected)) return;
    const ttl = this.config.roomTtlMs ?? DEFAULT_ROOM_TTL_MS;
    room.cleanupTimer = setTimeout(() => {
      room.cleanupTimer = null;
      if (this.rooms.get(room.code) !== room) return;
      if (room.players.some((player) => player.connected)) return;
      if (room.spectators.some((spectator) => spectator.connected)) return;
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
    if (room.tourId !== null && room.tourPhase !== 'finished') {
      // Phòng bị dọn giữa tour (hết TTL, không còn ai): đóng tour để không treo status running.
      this.config.store?.finishTour(room.tourId, 'incomplete', room.roundIndex);
    }
    room.game = null;
    room.matchId = null;
    room.tourId = null;
    room.tourPhase = null;
    room.roundIndex = 0;
    room.nextRoundAt = null;
    room.tourScores.clear();
    room.previousPlaces.clear();
    this.rooms.delete(room.code);
    for (const [socket, binding] of this.bindings) {
      if (binding.room !== room) continue;
      this.bindings.delete(socket);
      const account = binding.role === 'player' ? binding.player.account : binding.spectator.account;
      if (this.accountSockets.get(account) === socket) {
        this.accountSockets.delete(account);
      }
    }
    room.spectators.length = 0;
    this.scheduleRoomList();
  }

  /** Dừng mọi timer khi đóng server (test không bị treo). */
  dispose(): void {
    if (this.roomListTimer) {
      clearTimeout(this.roomListTimer);
      this.roomListTimer = null;
    }
    for (const room of this.rooms.values()) this.clearAllTimers(room);
    this.rooms.clear();
    this.bindings.clear();
    this.accountSockets.clear();
    this.sockets.clear();
  }

  private sendRoom(room: Room, viewer: RoomPlayer | RoomSpectator): void {
    if (!viewer.socket) return;
    this.send(viewer.socket, { t: 'room', room: this.publicRoom(room, viewer) });
  }

  private broadcastRoom(room: Room): void {
    for (const player of room.players) {
      if (player.socket) this.sendRoom(room, player);
    }
    for (const spectator of room.spectators) {
      if (spectator.socket) this.sendRoom(room, spectator);
    }
    this.scheduleRoomList();
  }

  private broadcastState(room: Room): void {
    for (const player of room.players) this.sendState(room, player);
    for (const spectator of room.spectators) this.sendState(room, spectator);
  }

  private broadcastDenBai(room: Room, event: DenBaiView): void {
    const message: ServerMessage = { t: 'denBai', event, serverNow: Date.now() };
    for (const player of room.players) {
      if (player.socket) this.send(player.socket, message);
    }
    for (const spectator of room.spectators) {
      if (spectator.socket) this.send(spectator.socket, message);
    }
  }

  private sendState(
    room: Room,
    viewer: RoomPlayer | RoomSpectator,
    options: { includeLog?: boolean } = {},
  ): void {
    if (!viewer.socket || viewer.socket.readyState !== 1) return;
    const isPlayer = 'seat' in viewer;
    this.send(viewer.socket, {
      t: 'state',
      you: { seat: isPlayer ? viewer.seat : -1, hand: isPlayer ? this.handOf(room, viewer) : [] },
      state: this.publicState(room),
      ...(options.includeLog ? { actionLog: this.publicActionLog(room) } : {}),
    });
  }

  private roomSummaries(): readonly RoomSummaryView[] {
    return [...this.rooms.values()]
      .map((room) => {
        const host = room.players.find(
          (player) => !player.left && player.seat === room.hostSeat,
        );
        return {
          code: room.code,
          hostNickname: host?.nickname ?? '',
          playerCount: room.players.filter((player) => !player.left).length,
          maxSeats: MAX_SEATS,
          phase: room.phase,
          spectatorCount: this.spectatorCount(room),
          roundIndex: room.tourId !== null ? room.roundIndex : null,
          soVan: room.tourId !== null ? room.soVan : null,
          canJoin:
            room.phase === 'lobby' &&
            !this.isTourActive(room) &&
            this.firstFreeSeat(room) !== null,
        };
      })
      .sort((a, b) => a.code.localeCompare(b.code));
  }

  /** Gom broadcast danh sách phòng 50ms/lần để không spam khi nhiều thay đổi liên tiếp. */
  private scheduleRoomList(): void {
    if (this.roomListTimer) return;
    this.roomListTimer = setTimeout(() => {
      this.roomListTimer = null;
      this.pushRoomList();
    }, 50);
    this.roomListTimer.unref?.();
  }

  /** Chỉ socket đang ở sảnh (chưa có binding) nhận push; socket trong phòng không cần. */
  private pushRoomList(): void {
    const message: ServerMessage = {
      t: 'roomList',
      rooms: this.roomSummaries(),
      serverNow: Date.now(),
    };
    for (const socket of this.sockets) {
      if (this.bindings.has(socket)) continue;
      this.send(socket, message);
    }
  }

  private sendRoomList(socket: WebSocket): void {
    this.send(socket, { t: 'roomList', rooms: this.roomSummaries(), serverNow: Date.now() });
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

  private spectatorCount(room: Room): number {
    return room.spectators.filter((spectator) => spectator.connected).length;
  }

  private publicRoom(room: Room, viewer: RoomPlayer | RoomSpectator): RoomView {
    const isPlayer = 'seat' in viewer;
    return {
      code: room.code,
      hostSeat: room.hostSeat,
      maxSeats: MAX_SEATS,
      phase: room.phase,
      players: room.players
        .filter((player) => !player.left)
        .slice()
        .sort((a, b) => a.seat - b.seat)
        .map((player) => ({
          seat: player.seat,
          nickname: player.nickname,
          ready: player.ready,
          connected: player.connected,
          isHost: player.seat === room.hostSeat,
        })),
      spectatorCount: this.spectatorCount(room),
      ...(room.tourId !== null ? { tour: this.tourView(room) } : {}),
      you: {
        seat: isPlayer ? viewer.seat : -1,
        token: viewer.token,
        role: isPlayer ? 'player' : 'spectator',
      },
    };
  }

  /** Bộ đánh ngay trước bộ đang dẫn trong cùng vòng (doc-5 §6); null ở đầu vòng. */
  private previousTableOf(game: GameState): TableView | null {
    const current = game.trick.lastPlay;
    if (!current) return null;
    let seenCurrent = false;
    for (let index = game.history.length - 1; index >= 0; index -= 1) {
      const entry = game.history[index];
      if (!entry) continue;
      if (entry.type !== 'play' && entry.type !== 'chop') continue;
      if (entry.trickId !== game.trick.id) continue;
      if (!seenCurrent) {
        if (entry.actionId === current.actionId) seenCurrent = true;
        continue;
      }
      return {
        cards: entry.cards.map(toCardView),
        seat: entry.seat,
        actionId: entry.actionId,
        comboKind: entry.combo.kind,
        comboSize: entry.combo.size,
      };
    }
    return null;
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
          denOut: false,
        })),
        table: null,
        trick: { id: 0, leader: -1, passed: [] },
        ranking: null,
        scores: null,
        turnDeadline: null,
        chopWindow: null,
        lastActionId: null,
        previousTable: null,
        ...(room.roundIndex > 0
          ? { roundIndex: room.roundIndex, firstMoveFree: false, firstSeat: -1 }
          : {}),
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

    // Hạng đã chốt luôn được công bố, kể cả khi ván còn chơi tiếp sau Nhất.
    const ranking: RankingView[] = game.ranking.map((entry) => ({
      seat: entry.seat,
      place: entry.place,
      cardsLeft: entry.cardsLeft,
    }));
    const placedSeats = new Set(ranking.map((entry) => entry.seat));

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

    const denBai = this.denBaiViews(game);

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
            placed: placedSeats.has(player.seat),
            denOut: gamePlayer?.denOut === true,
          };
        }),
      table,
      trick: { id: game.trick.id, leader: game.trick.leader, passed: [...game.trick.passed] },
      ranking,
      scores,
      ...(score ? { breakdown: score.breakdown } : {}),
      ...(denBai.length > 0 ? { denBai } : {}),
      turnDeadline: room.turnDeadline,
      chopWindow,
      lastActionId: game.lastActionId,
      previousTable: this.previousTableOf(game),
      roundIndex: game.roundIndex,
      firstMoveFree: game.firstMoveFree,
      firstSeat: game.startingPlayerIndex,
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
