import {
  createGame,
  type GameRulesInput,
  type GameState,
  type Placement,
} from './game';
import type { Card, FallbackPlace, FirstPlayerSubsequentConfig } from './types';

/**
 * doc-4 §4.1/§4.2: nguồn của ghế đi trước trong 1 ván.
 * - `round1`: ván đầu tour, người giữ 3♠ (fallback theo `rules.firstPlayer`).
 * - `previousWinner`: hạng Nhất ván trước.
 * - `fallback`: Nhất vắng mặt → hạng cao nhất còn trong phòng (Nhì → Ba → Bét).
 * - `hostSeat`: không còn ai có hạng ván trước → ghế chủ phòng (`seat0`).
 */
export type FirstSeatSource = 'round1' | 'previousWinner' | 'fallback' | 'hostSeat';

export const DEFAULT_FALLBACK_ORDER: readonly FallbackPlace[] = ['nhi', 'ba', 'bet'];

export const DEFAULT_SUBSEQUENT_CONFIG: FirstPlayerSubsequentConfig = {
  winnerLeads: true,
  firstMoveFree: true,
  fallback: 'highestPlacedPresent',
  fallbackOrder: DEFAULT_FALLBACK_ORDER,
  newSeatLast: true,
  emptyFallback: 'seat0',
  timeoutLeadPlaysLowest: true,
  rejectCode: null,
};

export interface FirstSeatInput {
  /** Số thứ tự ván trong tour, 1..N. */
  readonly roundIndex: number;
  readonly playerCount: number;
  /** Kết quả (hạng) ván trước, cùng hệ ghế với ván đang chuẩn bị. */
  readonly previousRanking?: readonly Placement[];
  /** Ghế đang có người; mặc định đủ 0..playerCount-1. Ghế vắng = người đã rời. */
  readonly presentSeats?: readonly number[];
  /** Ghế chủ phòng, dùng khi không còn ai có hạng ván trước. Mặc định 0. */
  readonly hostSeat?: number;
  /** `rules.firstPlayerSubsequent`; bỏ trống dùng mặc định trong code (= rules.json 1.5.0). */
  readonly config?: FirstPlayerSubsequentConfig;
  /** Ván 1: ghế đã suy ra từ 3♠ (xem `resolveStartingPlayer`). Mặc định 0. */
  readonly round1Seat?: number;
}

export interface FirstSeatResolution {
  readonly firstSeat: number;
  readonly firstMoveFree: boolean;
  readonly source: FirstSeatSource;
  readonly usedFallback: boolean;
  readonly roundIndex: number;
}

function validateRoundIndex(roundIndex: number): void {
  if (!Number.isInteger(roundIndex) || roundIndex < 1) {
    throw new RangeError(`roundIndex không hợp lệ: ${String(roundIndex)}`);
  }
}

/** `true` khi lượt đầu ván này được đánh tự do (doc-4 §4.2). */
export function firstMoveFreeForRound(
  roundIndex: number,
  config?: FirstPlayerSubsequentConfig,
): boolean {
  validateRoundIndex(roundIndex);
  if (roundIndex < 2) return false;
  return config?.firstMoveFree !== false;
}

function presentSeatList(playerCount: number, presentSeats?: readonly number[]): number[] {
  if (!Number.isInteger(playerCount) || playerCount < 1) {
    throw new RangeError(`playerCount không hợp lệ: ${String(playerCount)}`);
  }
  const source = presentSeats ?? Array.from({ length: playerCount }, (_, seat) => seat);
  const seen = new Set<number>();
  const seats: number[] = [];
  for (const seat of source) {
    if (!Number.isInteger(seat) || seat < 0 || seat >= playerCount) {
      throw new RangeError(`ghế không hợp lệ: ${String(seat)}`);
    }
    if (seen.has(seat)) continue;
    seen.add(seat);
    seats.push(seat);
  }
  if (seats.length === 0) throw new RangeError('không còn ghế nào trong phòng');
  return seats.sort((a, b) => a - b);
}

/**
 * doc-4 §4.2/§4.3: ai đi trước ván kế tiếp và lượt đầu có tự do không.
 * Thuần, deterministic, không phụ thuộc seed.
 *
 * Thứ tự: Nhất ván trước (nếu còn) → Nhì → Ba → Bét (theo `fallbackOrder`) →
 * ghế mới vào giữa tour (xếp cuối) → ghế chủ phòng → ghế nhỏ nhất còn lại.
 */
export function resolveFirstSeat(input: FirstSeatInput): FirstSeatResolution {
  validateRoundIndex(input.roundIndex);
  const config = input.config ?? DEFAULT_SUBSEQUENT_CONFIG;
  const present = presentSeatList(input.playerCount, input.presentSeats);

  if (input.roundIndex < 2) {
    return {
      firstSeat: input.round1Seat ?? 0,
      firstMoveFree: false,
      source: 'round1',
      usedFallback: false,
      roundIndex: input.roundIndex,
    };
  }

  const firstMoveFree = config.firstMoveFree !== false;
  const ranking = input.previousRanking ?? [];
  const isPresent = (seat: number): boolean => present.includes(seat);
  const placed = ranking.filter((entry) => isPresent(entry.seat));

  if (config.winnerLeads !== false) {
    const winner = placed.find((entry) => entry.place === 'nhat');
    if (winner) {
      return {
        firstSeat: winner.seat,
        firstMoveFree,
        source: 'previousWinner',
        usedFallback: false,
        roundIndex: input.roundIndex,
      };
    }
  }

  const fallbackOrder = config.fallbackOrder ?? DEFAULT_FALLBACK_ORDER;
  for (const place of fallbackOrder) {
    const holder = placed.find((entry) => entry.place === place);
    if (holder) {
      return {
        firstSeat: holder.seat,
        firstMoveFree,
        source: 'fallback',
        usedFallback: true,
        roundIndex: input.roundIndex,
      };
    }
  }

  // Ghế mới vào giữa tour (không có hạng ván trước) luôn xếp sau người đã có hạng.
  const hostSeat = input.hostSeat ?? 0;
  if (isPresent(hostSeat)) {
    return {
      firstSeat: hostSeat,
      firstMoveFree,
      source: 'hostSeat',
      usedFallback: true,
      roundIndex: input.roundIndex,
    };
  }
  return {
    firstSeat: present[0] ?? 0,
    firstMoveFree,
    source: 'hostSeat',
    usedFallback: true,
    roundIndex: input.roundIndex,
  };
}

/** Kết quả ván trước → hạng theo ghế; dùng làm input `previousRanking` của ván sau. */
export function rankingOf(state: GameState): readonly Placement[] {
  return state.ranking;
}

export interface CreateRoundGameOptions {
  readonly seed: number;
  readonly players: number;
  readonly rules: GameRulesInput;
  /** Hook test/dev, xem `CreateGameOptions.hands`. */
  readonly hands?: readonly (readonly Card[])[];
  readonly startingPlayerIndex?: number;
  readonly roundIndex?: number;
  readonly previousRanking?: readonly Placement[];
  readonly presentSeats?: readonly number[];
  readonly hostSeat?: number;
}

export interface RoundStart {
  readonly state: GameState;
  readonly firstSeat: number;
  readonly firstMoveFree: boolean;
  readonly source: FirstSeatSource;
  readonly usedFallback: boolean;
  readonly roundIndex: number;
}

/**
 * Tạo 1 ván trong tour.
 * - Ván 1: giữ luật 3♠ (`resolveStartingPlayer` từ bài đã chia).
 * - Ván ≥ 2: ghế đi trước lấy từ `previousRanking`/`presentSeats`, lượt đầu tự do.
 */
export function createRoundGame(options: CreateRoundGameOptions): RoundStart {
  const roundIndex = options.roundIndex ?? 1;
  validateRoundIndex(roundIndex);
  const config = options.rules.firstPlayerSubsequent;

  if (roundIndex < 2) {
    const state = createGame({
      seed: options.seed,
      players: options.players,
      rules: options.rules,
      roundIndex: 1,
      firstMoveFree: false,
      ...(options.hands ? { hands: options.hands } : {}),
      ...(options.startingPlayerIndex === undefined
        ? {}
        : { startingPlayerIndex: options.startingPlayerIndex }),
    });
    return {
      state,
      firstSeat: state.startingPlayerIndex,
      firstMoveFree: false,
      source: 'round1',
      usedFallback: false,
      roundIndex: 1,
    };
  }

  const first = resolveFirstSeat({
    roundIndex,
    playerCount: options.players,
    ...(options.previousRanking ? { previousRanking: options.previousRanking } : {}),
    ...(options.presentSeats ? { presentSeats: options.presentSeats } : {}),
    ...(options.hostSeat === undefined ? {} : { hostSeat: options.hostSeat }),
    ...(config ? { config } : {}),
  });

  const state = createGame({
    seed: options.seed,
    players: options.players,
    rules: options.rules,
    roundIndex,
    firstSeat: first.firstSeat,
    firstMoveFree: first.firstMoveFree,
    ...(options.hands ? { hands: options.hands } : {}),
  });

  return {
    state,
    firstSeat: first.firstSeat,
    firstMoveFree: first.firstMoveFree,
    source: first.source,
    usedFallback: first.usedFallback,
    roundIndex,
  };
}

/** Thông tin gọn để server/UI hiện "Nhất: <tên> đi trước ván tới". */
export function describeFirstSeat(resolution: FirstSeatResolution): {
  readonly firstSeat: number;
  readonly firstMoveFree: boolean;
  readonly fallbackUsed: boolean;
  readonly source: FirstSeatSource;
} {
  return {
    firstSeat: resolution.firstSeat,
    firstMoveFree: resolution.firstMoveFree,
    fallbackUsed: resolution.usedFallback,
    source: resolution.source,
  };
}

/** Ghế chưa có hạng ván trước (người mới vào giữa tour) — xếp cuối khi fallback. */
export function newSeatsSince(
  playerCount: number,
  previousRanking: readonly Placement[],
  presentSeats?: readonly number[],
): readonly number[] {
  const present = presentSeatList(playerCount, presentSeats);
  const ranked = new Set(previousRanking.map((entry) => entry.seat));
  return present.filter((seat) => !ranked.has(seat));
}
