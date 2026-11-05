import type {
  CardView,
  PublicGameState,
  RankingView,
  RoomPhase,
  RoomPlayerView,
  RoomView,
  StatePlayerView,
  TourView,
} from '../net/protocol';
import { tourPhaseLabel } from './tour';

export type Screen = 'lobby' | 'table';

/** Khán giả không có ghế (`seat === -1`) hoặc server khai báo `role`. */
export function isSpectatorRoom(room: RoomView | null): boolean {
  if (room === null) return false;
  return room.you.role === 'spectator' || room.you.seat === -1;
}

export function resolveScreen(room: RoomView | null): Screen {
  if (room === null) return 'lobby';
  // Khán giả vào xem phòng còn ở lobby (đầy ghế) vẫn phải thấy bàn bài.
  if (isSpectatorRoom(room)) return 'table';
  return room.phase !== 'lobby' ? 'table' : 'lobby';
}

/** Tour đang chạy thì không nhận người mới vào ghế (doc-5 §4.1). */
function isTourActiveView(tour: TourView | undefined): boolean {
  if (tour === undefined) return false;
  return tour.phase === 'running' || tour.phase === 'betweenRounds' || tour.phase === 'paused';
}

export const NICKNAME_MAX_LENGTH = 20;
const ROOM_CODE_PATTERN = /^[A-Z0-9]{4,6}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function normalizeNickname(value: string): string {
  return value.trim();
}

export function validateNickname(value: string): string | null {
  const nickname = normalizeNickname(value);
  if (nickname.length === 0) return 'Nhập nickname trước khi chơi.';
  if (nickname.length > NICKNAME_MAX_LENGTH) {
    return `Nickname tối đa ${NICKNAME_MAX_LENGTH} ký tự.`;
  }
  if (CONTROL_CHARS.test(nickname)) return 'Nickname chứa ký tự không hợp lệ.';
  return null;
}

export function normalizeRoomCode(value: string): string {
  return value.trim().toUpperCase();
}

export function validateRoomCode(value: string): string | null {
  return ROOM_CODE_PATTERN.test(normalizeRoomCode(value))
    ? null
    : 'Mã phòng gồm 4-6 ký tự A-Z hoặc 0-9.';
}

export interface LobbySeatView {
  readonly seat: number;
  readonly label: string;
  readonly nickname: string | null;
  readonly ready: boolean;
  readonly isHost: boolean;
  readonly isYou: boolean;
  readonly connected: boolean;
}

export interface LobbyView {
  readonly roomCode: string;
  readonly seats: readonly LobbySeatView[];
  readonly youSeat: number;
  readonly isHost: boolean;
  readonly selfReady: boolean;
  readonly playerCount: number;
  readonly maxSeats: number;
  readonly canStart: boolean;
  readonly canToggleReady: boolean;
}

export function buildLobbyView(room: RoomView): LobbyView {
  const seats: LobbySeatView[] = [];
  for (let seat = 0; seat < room.maxSeats; seat += 1) {
    const player: RoomPlayerView | undefined = room.players.find((entry) => entry.seat === seat);
    seats.push({
      seat,
      label: `Ghế ${seat + 1}`,
      nickname: player ? player.nickname : null,
      ready: player ? player.ready : false,
      isHost: player ? player.isHost : false,
      isYou: player !== undefined && player.seat === room.you.seat,
      connected: player ? player.connected : false,
    });
  }

  const self = room.players.find((entry) => entry.seat === room.you.seat);
  return {
    roomCode: room.code,
    seats,
    youSeat: room.you.seat,
    isHost: room.hostSeat === room.you.seat,
    selfReady: self ? self.ready : false,
    playerCount: room.players.length,
    maxSeats: room.maxSeats,
    canStart:
      room.phase === 'lobby' && room.hostSeat === room.you.seat && room.players.length >= 2,
    canToggleReady: room.phase === 'lobby',
  };
}

export interface TableSeatView {
  readonly seat: number;
  readonly label: string;
  readonly nickname: string | null;
  readonly cardsLeft: number;
  readonly isTurn: boolean;
  readonly isYou: boolean;
  readonly connected: boolean;
  readonly surrendered: boolean;
  /** Ghế đã chốt hạng (về đích hoặc rời ván) — có thể xảy ra khi ván còn chơi tiếp. */
  readonly placed: boolean;
  /** Hạng đã chốt theo `state.ranking`; null khi chưa có trong bảng hạng. */
  readonly place: RankingView['place'] | null;
  /** rev6 §1.7: giữ đủ 13 lá → đền, rời ván, không hạng/không thối. */
  readonly denOut: boolean;
  /** Điểm đền đã trả (dương), 0 khi không đền. */
  readonly denPoints: number;
}

export interface TableViewModel {
  readonly roomCode: string;
  readonly phase: RoomPhase;
  readonly phaseLabel: string;
  readonly seats: readonly TableSeatView[];
  readonly youSeat: number;
  readonly turnSeat: number | null;
  readonly turnLabel: string;
  readonly handCount: number;
  readonly tableCards: readonly CardView[];
  readonly lastPlayLabel: string | null;
  /** Bộ đánh ngay trước bộ đang dẫn trong cùng vòng (doc-5 §6); rỗng khi không có. */
  readonly previousTableCards: readonly CardView[];
  /** Ghế đánh bộ trước; null khi không có bộ trước. */
  readonly previousTableSeat: number | null;
  /** `An đánh 1 lá` cho bộ trước; null khi không có. */
  readonly previousTableLabel: string | null;
  /** Số lá của bộ trước; 0 khi không có. */
  readonly previousTableComboSize: number;
  /** Hạng đã chốt, có thể rỗng/thiếu ghế khi ván còn chơi tiếp. */
  readonly ranking: readonly RankingView[] | null;
  readonly scores: readonly number[] | null;
  readonly isFinished: boolean;
  /** Ghế của bạn đã chốt hạng/đã rời ván hay chưa. */
  readonly youPlaced: boolean;
  /** Hạng của bạn nếu đã có trong bảng hạng. */
  readonly youPlace: RankingView['place'] | null;
  /** Bạn giữ đủ 13 lá → đã đền, rời ván (rev6 §1.7). */
  readonly youDenOut: boolean;
  /** `Ván i/N` của tour; null khi phòng không mở tour. */
  readonly roundIndex: number | null;
  readonly soVan: number | null;
  /** Ghế đi trước ván này (`state.firstSeat`), null nếu server cũ. */
  readonly firstSeat: number | null;
  readonly firstPlayerNickname: string | null;
  /** true = lượt đầu ván này đánh tự do (ván ≥ 2). */
  readonly firstMoveFree: boolean;
  readonly tourLabel: string | null;
  /** Bạn đang xem với tư cách khán giả (không có ghế, không có bài). */
  readonly isSpectator: boolean;
  /** Số khán giả hiện tại của phòng; 0 khi server cũ không gửi. */
  readonly spectatorCount: number;
  /** Khán giả có thể xin vào ghế trống (lobby, còn ghế, tour không chạy). */
  readonly canTakeSeat: boolean;
}

const PHASE_LABELS: Readonly<Record<RoomPhase, string>> = {
  lobby: 'Phòng chờ',
  playing: 'Đang chơi',
  finished: 'Kết thúc',
};

export function buildTableView(
  room: RoomView,
  state: PublicGameState | null,
  hand: readonly CardView[],
): TableViewModel {
  const statePlayers = new Map<number, StatePlayerView>(
    (state?.players ?? []).map((player) => [player.seat, player]),
  );

  // Khi ván còn chơi tiếp, `ranking` chỉ chứa các ghế đã chốt hạng (có thể rỗng/thiếu ghế).
  const ranking = state?.ranking ?? [];
  const placeBySeat = new Map<number, RankingView['place']>();
  for (const entry of ranking) {
    if (typeof entry?.seat !== 'number') continue;
    if (!placeBySeat.has(entry.seat)) placeBySeat.set(entry.seat, entry.place);
  }
  // `placed` là cờ server chốt; dùng làm fallback khi ranking chưa/không có entry cho ghế đó.
  const placedSeats = new Set<number>(placeBySeat.keys());
  for (const player of statePlayers.values()) {
    if (player.placed === true) placedSeats.add(player.seat);
  }

  const denPointsBySeat = new Map<number, number>();
  for (const entry of state?.denBai ?? []) {
    denPointsBySeat.set(entry.who, (denPointsBySeat.get(entry.who) ?? 0) + entry.points);
  }

  const rawTurnSeat = state !== null && state.phase === 'playing' ? state.turn : null;
  // Ghế đã về/đã đền không bao giờ bị highlight lượt, kể cả khi state tạm thời trỏ tới họ.
  const turnSeat =
    rawTurnSeat !== null &&
    (placedSeats.has(rawTurnSeat) || denPointsBySeat.has(rawTurnSeat))
      ? null
      : rawTurnSeat;

  const seats: TableSeatView[] = [];
  for (let seat = 0; seat < room.maxSeats; seat += 1) {
    const roomPlayer = room.players.find((entry) => entry.seat === seat);
    const statePlayer = statePlayers.get(seat);
    const place = placeBySeat.get(seat) ?? null;
    const denPoints = denPointsBySeat.get(seat) ?? 0;
    seats.push({
      seat,
      label: `Ghế ${seat + 1}`,
      nickname: roomPlayer ? roomPlayer.nickname : null,
      cardsLeft: statePlayer ? statePlayer.cardsLeft : 0,
      isTurn: turnSeat === seat,
      isYou: roomPlayer !== undefined && seat === room.you.seat,
      connected: statePlayer ? statePlayer.connected : roomPlayer?.connected ?? false,
      surrendered: statePlayer ? statePlayer.surrendered : false,
      placed: placedSeats.has(seat),
      place,
      denOut: statePlayer?.denOut === true || denPoints > 0,
      denPoints,
    });
  }

  const youPlace = placeBySeat.get(room.you.seat) ?? null;
  const youPlaced = placedSeats.has(room.you.seat);

  const turnPlayer = turnSeat === null ? undefined : state?.players.find((p) => p.seat === turnSeat);
  const turnLabel =
    turnSeat === null
      ? 'Chưa tới lượt ai'
      : turnSeat === room.you.seat
        ? 'Lượt của bạn'
        : `Lượt của ${turnPlayer ? turnPlayer.nickname : `ghế ${turnSeat + 1}`}`;

  const table = state?.table ?? null;
  const lastPlayer = table ? state?.players.find((p) => p.seat === table.seat) : undefined;
  const lastPlayLabel = table
    ? `${lastPlayer ? lastPlayer.nickname : `Ghế ${table.seat + 1}`} đánh ${table.comboSize} lá`
    : null;

  // Server chỉ gửi previousTable trong cùng vòng; client cũ hoặc thiếu → không vẽ lớp mờ.
  const previous = state?.previousTable ?? null;
  const previousCards = previous ? previous.cards : [];
  const previousPlayer =
    previous === null ? undefined : state?.players.find((p) => p.seat === previous.seat);
  const previousTableLabel =
    previous === null
      ? null
      : `${previousPlayer ? previousPlayer.nickname : `Ghế ${previous.seat + 1}`} đánh ${previous.comboSize} lá`;

  const firstSeat = state?.firstSeat ?? null;
  const firstPlayer =
    firstSeat === null ? undefined : state?.players.find((p) => p.seat === firstSeat);
  const firstPlayerNickname =
    firstSeat === null
      ? null
      : firstPlayer?.nickname ??
        room.players.find((p) => p.seat === firstSeat)?.nickname ??
        `Ghế ${firstSeat + 1}`;
  const roundIndex = state?.roundIndex ?? room.tour?.roundIndex ?? null;
  const isSpectator = isSpectatorRoom(room);
  const spectatorCount = room.spectatorCount ?? 0;
  const canTakeSeat =
    isSpectator &&
    room.phase === 'lobby' &&
    !isTourActiveView(room.tour) &&
    room.players.length < room.maxSeats;

  return {
    roomCode: room.code,
    phase: state?.phase ?? room.phase,
    phaseLabel: PHASE_LABELS[state?.phase ?? room.phase],
    seats,
    youSeat: room.you.seat,
    turnSeat,
    turnLabel,
    handCount: hand.length,
    tableCards: table ? table.cards : [],
    lastPlayLabel,
    previousTableCards: previousCards,
    previousTableSeat: previous === null ? null : previous.seat,
    previousTableLabel,
    previousTableComboSize: previous === null ? 0 : previous.comboSize,
    ranking: state?.ranking ?? null,
    scores: state?.scores ?? null,
    isFinished: (state?.phase ?? room.phase) === 'finished',
    youPlaced,
    youPlace,
    youDenOut:
      statePlayers.get(room.you.seat)?.denOut === true || denPointsBySeat.has(room.you.seat),
    roundIndex,
    soVan: room.tour?.soVan ?? null,
    firstSeat,
    firstPlayerNickname,
    firstMoveFree: state?.firstMoveFree === true,
    tourLabel: tourPhaseLabel(room.tour),
    isSpectator,
    spectatorCount,
    canTakeSeat,
  };
}
