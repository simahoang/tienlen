import type {
  CardView,
  PublicGameState,
  RankingView,
  RoomPhase,
  RoomPlayerView,
  RoomView,
  StatePlayerView,
} from '../net/protocol';

export type Screen = 'lobby' | 'table';

export function resolveScreen(room: RoomView | null): Screen {
  return room !== null && room.phase !== 'lobby' ? 'table' : 'lobby';
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
  readonly ranking: readonly RankingView[] | null;
  readonly scores: readonly number[] | null;
  readonly isFinished: boolean;
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
  const turnSeat = state !== null && state.phase === 'playing' ? state.turn : null;

  const seats: TableSeatView[] = [];
  for (let seat = 0; seat < room.maxSeats; seat += 1) {
    const roomPlayer = room.players.find((entry) => entry.seat === seat);
    const statePlayer = statePlayers.get(seat);
    seats.push({
      seat,
      label: `Ghế ${seat + 1}`,
      nickname: roomPlayer ? roomPlayer.nickname : null,
      cardsLeft: statePlayer ? statePlayer.cardsLeft : 0,
      isTurn: turnSeat === seat,
      isYou: roomPlayer !== undefined && seat === room.you.seat,
      connected: statePlayer ? statePlayer.connected : roomPlayer?.connected ?? false,
      surrendered: statePlayer ? statePlayer.surrendered : false,
    });
  }

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
    ranking: state?.ranking ?? null,
    scores: state?.scores ?? null,
    isFinished: (state?.phase ?? room.phase) === 'finished',
  };
}
