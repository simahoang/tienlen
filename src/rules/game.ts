import {
  canBeat,
  type BeatContext,
  type BeatResult,
  type ChopHeoLike,
} from './compare';
import { classifyCombo, type Combo, type ComboRulesMap } from './combos';
import { createCardOrder, type CardOrder } from './deck';
import { dealCards, resolveStartingPlayer } from './deal';
import { normalizeSeed } from './rng';
import { detectToiTrang } from './toiTrang';
import type {
  Card,
  ChopAttacker,
  ChopTarget,
  DeckConfig,
  FirstPlayerSubsequentConfig,
  StartingPlayerConfig,
  ToiTrangCombo,
} from './types';

export interface ChatNgoaiLuotInput {
  readonly enabled: boolean;
  readonly windowMs: number;
  readonly passedCannotChop: boolean;
  readonly pauseTurnTimer: boolean;
  readonly opensOn: readonly ChopTarget[];
  readonly tieBreak: string;
}

export interface ToiTrangInput {
  readonly enabled: boolean;
  readonly combos: readonly ToiTrangCombo[];
  readonly priority: readonly ToiTrangCombo[];
  readonly tieBreak: string;
  readonly sanh13LaLeDuocLaHai?: boolean;
  readonly tuQuyDemHaiDoi?: boolean;
}

/** Phần cấu hình tối thiểu mà state machine cần; `RulesConfig` trong src/data thoả interface này. */
export interface ScoringRulesInput {
  readonly places: Readonly<Record<'nhat' | 'nhi' | 'ba' | 'bet', number>>;
  readonly toiTrang: { readonly points: number };
  readonly values: {
    readonly heoDen: number;
    readonly heoDo: number;
    readonly baDoiThong: number;
    readonly tuQuy: number;
    readonly bonDoiThong: number;
  };
  readonly den: { readonly giu13La: number };
}

export interface DenBaiInput {
  readonly enabled: boolean;
  readonly chatChongGanhChuoi: boolean;
  /** rev6: pot cộng dồn = tổng giá trị mọi nước trong chuỗi (bỏ revert về 0). */
  readonly chatChongCongDon?: boolean;
  /** rev5 cũ, chỉ dùng khi `chatChongCongDon` tắt. */
  readonly chatChongTheoGiaTriMucTieu?: boolean;
}

export interface GameRulesInput {
  readonly deck: DeckConfig;
  readonly deal: {
    readonly cardsPerPlayer: number;
    readonly playerCounts: readonly { readonly players: number }[];
  };
  readonly firstPlayer: StartingPlayerConfig;
  readonly combos: ComboRulesMap;
  readonly chatHeo: ChopHeoLike;
  readonly scoring: ScoringRulesInput;
  readonly chatNgoaiLuot: ChatNgoaiLuotInput;
  readonly toiTrang: ToiTrangInput;
  readonly denBai?: DenBaiInput;
  /** doc-4 §4.2/§4.3 — luật đi trước ván ≥ 2 của tour. */
  readonly firstPlayerSubsequent?: FirstPlayerSubsequentConfig;
  readonly turn?: { readonly autoPlayLowestWhenLeading?: boolean };
}

export interface CreateGameOptions {
  readonly seed: number;
  readonly players: number;
  readonly rules: GameRulesInput;
  /**
   * Hook test/dev: chia tay thủ công thay cho `dealCards` (cho phép tay lệch số lá để
   * test xếp hạng). Mỗi tay phải có lá, không trùng lá. Production luôn chia bằng seed.
   */
  readonly hands?: readonly (readonly Card[])[];
  readonly startingPlayerIndex?: number;
  /**
   * doc-4 §4.2: ghế đi trước do caller quyết định (ván ≥ 2 = hạng Nhất ván trước).
   * Không truyền → ván 1, suy ra từ 3♠ như cũ hoặc từ `startingPlayerIndex`.
   */
  readonly firstSeat?: number;
  /** doc-4 §4.2: lượt đầu đánh tự do (bỏ ràng buộc 3♠). Mặc định theo `roundIndex`. */
  readonly firstMoveFree?: boolean;
  /** Số thứ tự ván trong tour, 1..N. Mặc định 1. */
  readonly roundIndex?: number;
}

export type Place = 'nhat' | 'nhi' | 'ba' | 'bet';

export interface GamePlayer {
  readonly seat: number;
  /** Bài trên tay. Giữ lại cả khi đã xin hàng để pha 3 tính thối. */
  readonly hand: readonly Card[];
  readonly surrendered: boolean;
  /** rev6 §1.7: giữ đủ 13 lá khi có Nhất → ra khỏi ván, không hạng, không thối. */
  readonly denOut?: boolean;
}

export interface PlayRecord {
  readonly actionId: string;
  readonly seat: number;
  readonly cards: readonly Card[];
  readonly combo: Combo;
}

export interface TrickState {
  /** Số thứ tự vòng, dùng cho log/replay. */
  readonly id: number;
  /** Ghế mở vòng hiện tại. */
  readonly leader: number;
  /** Nước đang dẫn; `null` = đầu vòng, được đánh tự do. */
  readonly lastPlay: PlayRecord | null;
  /** Các ghế đã pass trong vòng này, nghỉ tới vòng sau. */
  readonly passed: readonly number[];
  readonly playCount: number;
}

export type GameHistoryEntry =
  | {
      readonly type: 'play';
      readonly actionId: string;
      readonly seat: number;
      readonly trickId: number;
      readonly cards: readonly Card[];
      readonly combo: Combo;
      /** true khi server auto đánh do hết giờ (không phải intent người chơi). */
      readonly auto?: boolean;
    }
  | {
      readonly type: 'pass';
      readonly actionId: string;
      readonly seat: number;
      readonly trickId: number;
      readonly auto: boolean;
      /** Tại thời điểm pass, tay còn nước đè hợp lệ hay không (telemetry/replay). */
      readonly couldBeat: boolean;
    }
  | {
      readonly type: 'chop';
      readonly actionId: string;
      readonly seat: number;
      readonly trickId: number;
      readonly cards: readonly Card[];
      readonly combo: Combo;
      readonly targetActionId: string;
      readonly targetBy: number;
      readonly points: number | null;
      readonly chop: { readonly attacker: ChopAttacker; readonly target: ChopTarget } | null;
    }
  | { readonly type: 'surrender'; readonly actionId: string; readonly seat: number };

export interface Placement {
  readonly seat: number;
  readonly place: Place;
  readonly cardsLeft: number;
}

export interface ChopWindowState {
  readonly openAt: number;
  readonly closesAt: number;
  readonly targetActionId: string;
  readonly targetCards: readonly Card[];
  readonly targetBy: number;
}

export interface ChopRecord {
  readonly actionId: string;
  readonly seat: number;
  readonly cards: readonly Card[];
  readonly combo: Combo;
  readonly targetActionId: string;
  readonly targetBy: number;
  readonly atMs: number;
}

export interface ToiTrangInfo {
  readonly seat: number;
  readonly combo: ToiTrangCombo;
}

export type GamePhase = 'playing' | 'finished';

export interface GameState {
  readonly seed: number;
  readonly playerCount: number;
  readonly rules: GameRulesInput;
  readonly order: CardOrder;
  readonly players: readonly GamePlayer[];
  readonly phase: GamePhase;
  /** Ghế đang tới lượt; `-1` khi ván kết thúc. */
  readonly turn: number;
  readonly startingPlayerIndex: number;
  readonly firstMustContain3S: boolean;
  /** doc-4 §4.2: ván ≥ 2 lượt đầu tự do (không bắt buộc chứa 3♠). */
  readonly firstMoveFree: boolean;
  /** Số thứ tự ván trong tour (1 = ván đầu). */
  readonly roundIndex: number;
  readonly firstPlayDone: boolean;
  readonly trick: TrickState;
  readonly ranking: readonly Placement[];
  readonly actionCount: number;
  readonly lastActionId: string | null;
  /** Cửa sổ chặt ngoài lượt §2.5; `null` = đang đóng. */
  readonly chopWindow: ChopWindowState | null;
  /** Lần chặt ngoài lượt gần nhất, dùng để trả LOST_RACE cho người đến sau. */
  readonly lastChop: ChopRecord | null;
  readonly lastNowMs: number;
  readonly toiTrang: ToiTrangInfo | null;
  /** Log hành động theo thứ tự, phục vụ tính điểm (pha 3) và replay (pha 4). */
  readonly history: readonly GameHistoryEntry[];
}

export type GameErrorCode =
  | 'GAME_OVER'
  | 'NOT_IN_GAME'
  | 'NOT_YOUR_TURN'
  | 'ALREADY_PASSED'
  | 'PLAYER_OUT'
  | 'INVALID_INTENT'
  | 'INVALID_CARDS'
  | 'CARD_NOT_IN_HAND'
  | 'INVALID_COMBO'
  | 'INVALID_BEAT'
  | 'FIRST_MUST_CONTAIN_3S'
  | 'CANNOT_PASS_WHEN_LEADING'
  | 'ALREADY_SURRENDERED'
  | 'TURN_PAUSED'
  | 'WINDOW_CLOSED'
  | 'INVALID_TARGET'
  | 'LOST_RACE'
  /** Cấu hình tắt auto đánh khi mở vòng (`timeoutLeadPlaysLowest=false`). */
  | 'LEAD_AUTO_DISABLED';

export interface GameError {
  readonly code: GameErrorCode;
  readonly message: string;
  readonly seat: number | null;
  readonly detail: string | null;
}

export type GameEvent =
  | {
      readonly type: 'play';
      readonly seat: number;
      readonly actionId: string;
      readonly cards: readonly Card[];
      readonly combo: Combo;
    }
  | { readonly type: 'pass'; readonly seat: number; readonly auto: boolean }
  | { readonly type: 'surrender'; readonly seat: number }
  | {
      readonly type: 'chop';
      readonly seat: number;
      readonly actionId: string;
      readonly cards: readonly Card[];
      readonly combo: Combo;
      readonly targetActionId: string;
    }
  | { readonly type: 'chopWindowOpen'; readonly window: ChopWindowState }
  | {
      readonly type: 'chopWindowClose';
      readonly reason: 'timeout' | 'nextAction' | 'chop';
    }
  | { readonly type: 'trickWon'; readonly seat: number; readonly newTrickLeader: number }
  | { readonly type: 'gameOver'; readonly ranking: readonly Placement[] };

export type Intent =
  | {
      readonly type: 'play';
      readonly seat: number;
      /** Nhận `Card` hoặc id; server luôn tra lại từ tay để chống giả mạo rank/suit. */
      readonly cards: readonly (string | Card)[];
      readonly auto?: boolean;
    }
  | { readonly type: 'pass'; readonly seat: number; readonly auto?: boolean }
  | { readonly type: 'surrender'; readonly seat: number }
  | {
      readonly type: 'chop';
      readonly seat: number;
      readonly cards: readonly (string | Card)[];
      readonly targetActionId: string;
    };

export interface ApplyOptions {
  /** Giờ server (ms). Mặc định dùng `state.lastNowMs` để engine thuần, không đọc Date.now. */
  readonly nowMs?: number;
}

export interface ApplyResult {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
  readonly error: GameError | null;
}

function failure(
  state: GameState,
  code: GameErrorCode,
  message: string,
  seat: number | null = null,
  detail: string | null = null,
): ApplyResult {
  return { state, events: [], error: { code, message, seat, detail } };
}

function containsPrimary(cards: readonly Card[], firstPlayer: StartingPlayerConfig): boolean {
  return cards.some(
    (card) => card.rank === firstPlayer.primaryCard.rank && card.suit === firstPlayer.primaryCard.suit,
  );
}

function isPlayablePlayer(player: GamePlayer): boolean {
  return !player.surrendered && player.hand.length > 0 && player.denOut !== true;
}

/** rev6 §1.7: khi đã có Nhất, mọi ghế còn đủ 13 lá ra khỏi ván ngay. */
function applyDenBai(state: GameState): GameState {
  if (!(state.rules.denBai?.enabled ?? true)) return state;
  const fullHand = state.rules.deal.cardsPerPlayer;
  let changed = false;
  const players = state.players.map((player) => {
    if (player.denOut === true || player.surrendered) return player;
    if (player.hand.length !== fullHand) return player;
    changed = true;
    return { ...player, denOut: true };
  });
  return changed ? { ...state, players } : state;
}

function resolveHandCards(
  hand: readonly Card[],
  input: readonly (string | Card)[],
): Card[] | null {
  const seen = new Set<string>();
  const cards: Card[] = [];
  for (const item of input) {
    const id = typeof item === 'string' ? item : item.id;
    if (seen.has(id)) return null;
    const found = hand.find((card) => card.id === id);
    if (!found) return null;
    seen.add(id);
    cards.push(found);
  }
  return cards;
}

/** Ghế kế tiếp còn đánh được và chưa pass trong vòng hiện tại. */
export function nextPlayableSeat(state: GameState, from: number): number | null {
  const count = state.playerCount;
  for (let step = 1; step <= count; step += 1) {
    const seat = (from + step) % count;
    const player = state.players[seat];
    if (!player || !isPlayablePlayer(player)) continue;
    if (state.trick.passed.includes(seat)) continue;
    return seat;
  }
  return null;
}

function nextAnyPlayableSeat(state: GameState, from: number): number | null {
  const count = state.playerCount;
  for (let step = 1; step <= count; step += 1) {
    const seat = (from + step) % count;
    const player = state.players[seat];
    if (player && isPlayablePlayer(player)) return seat;
  }
  return null;
}

function isTrickComplete(state: GameState): boolean {
  const last = state.trick.lastPlay;
  if (!last) return false;
  const others = state.players.filter(
    (player) => player.seat !== last.seat && isPlayablePlayer(player),
  );
  return others.every((player) => state.trick.passed.includes(player.seat));
}

function placeOf(index: number, count: number): Place {
  if (index === 0) return 'nhat';
  if (index >= count - 1) return 'bet';
  if (index === 1) return 'nhi';
  return 'ba';
}

const PLACE_ORDER: readonly Place[] = ['nhat', 'nhi', 'ba', 'bet'];

/** §1.7: 4 người đủ 4 hạng; 3 người Nhất/Nhì/Bét (không có Ba); 2 người Nhất/Bét. */
function placesForCount(count: number): readonly Place[] {
  if (count <= 2) return ['nhat', 'bet'];
  if (count === 3) return ['nhat', 'nhi', 'bet'];
  return PLACE_ORDER;
}

function placeOrderIndex(place: Place): number {
  return PLACE_ORDER.indexOf(place);
}

/** Các hạng chưa chốt, xếp từ cao xuống thấp. */
function remainingPlaces(state: GameState): Place[] {
  const used = new Set(state.ranking.map((entry) => entry.place));
  return placesForCount(state.playerCount).filter((place) => !used.has(place));
}

/** Ghi một hạng vào `state.ranking`, giữ mảng luôn xếp từ Nhất xuống Bét. */
function addPlacement(state: GameState, seat: number, place: Place): GameState {
  const cardsLeft = state.players[seat]?.hand.length ?? 0;
  const ranking = [...state.ranking, { seat, place, cardsLeft }].sort(
    (a, b) => placeOrderIndex(a.place) - placeOrderIndex(b.place),
  );
  return { ...state, ranking };
}

/** Ghế vừa hết bài nhận hạng cao nhất còn lại (thứ tự về = thứ tự hạng). */
function recordFinish(state: GameState, seat: number): GameState {
  const remaining = remainingPlaces(state);
  const place = remaining[0];
  if (!place) return state;
  const ranked = addPlacement(state, seat, place);
  // Có Nhất → xét đền 13 lá ngay tại thời điểm này.
  return place === 'nhat' ? applyDenBai(ranked) : ranked;
}

/**
 * §1.7: ván chỉ kết thúc khi còn ≤1 người chưa xếp hạng. Người cuối cùng
 * nhận hạng cao nhất còn lại; đủ hạng thì mới phát `gameOver`.
 */
function finalizeRanking(state: GameState, events: GameEvent[]): GameState {
  const ranked = new Set(state.ranking.map((entry) => entry.seat));
  const unranked = state.players.filter(
    (player) => !ranked.has(player.seat) && player.denOut !== true,
  );
  if (unranked.length > 1) return state;

  let next = state;
  const last = unranked[0];
  if (last) {
    const place = remainingPlaces(next)[0];
    if (place) next = addPlacement(next, last.seat, place);
  }
  next = { ...next, phase: 'finished', turn: -1, chopWindow: null };
  events.push({ type: 'gameOver', ranking: next.ranking });
  return next;
}

function highestCardOf(player: GamePlayer, order: CardOrder): Card | null {
  let highest: Card | null = null;
  for (const card of player.hand) {
    if (highest === null || order.compare(card, highest) > 0) highest = card;
  }
  return highest;
}

/** Xếp hạng các nhà còn lại khi tới trắng: ít lá hơn xếp trên; bằng số lá thì lá cao nhất thấp hơn xếp trên. */
function compareForRank(a: GamePlayer, b: GamePlayer, state: GameState): number {
  const bySize = a.hand.length - b.hand.length;
  if (bySize !== 0) return bySize;
  const highestA = highestCardOf(a, state.order);
  const highestB = highestCardOf(b, state.order);
  if (highestA === null && highestB !== null) return -1;
  if (highestA !== null && highestB === null) return 1;
  if (highestA !== null && highestB !== null) {
    const byCard = state.order.compare(highestA, highestB);
    if (byCard !== 0) return byCard;
  }
  const turn = state.turn < 0 ? 0 : state.turn;
  const distanceA = (a.seat - turn + state.playerCount) % state.playerCount;
  const distanceB = (b.seat - turn + state.playerCount) % state.playerCount;
  if (distanceA !== distanceB) return distanceA - distanceB;
  return a.seat - b.seat;
}

/** §2.2 tới trắng: ván dừng ngay, xếp các nhà còn lại theo số lá/lá cao nhất như cũ. */
function finishGame(state: GameState, winnerSeat: number | null): GameState {
  const active = state.players.filter((player) => !player.surrendered);
  const winnerPlayer = winnerSeat === null ? undefined : state.players[winnerSeat];
  const winner =
    winnerPlayer && !winnerPlayer.surrendered ? winnerPlayer.seat : (active[0]?.seat ?? 0);
  const rest = active
    .filter((player) => player.seat !== winner)
    .sort((a, b) => compareForRank(a, b, state));
  const out = state.players
    .filter((player) => player.surrendered)
    .sort((a, b) => compareForRank(a, b, state));
  const seats = [winner, ...rest.map((player) => player.seat), ...out.map((player) => player.seat)];
  const ranking = seats.map((seat, index) => ({
    seat,
    place: placeOf(index, state.playerCount),
    cardsLeft: state.players[seat]?.hand.length ?? 0,
  }));
  return { ...state, phase: 'finished', turn: -1, ranking, chopWindow: null };
}

function startNextTrick(state: GameState, events: GameEvent[]): GameState {
  const last = state.trick.lastPlay;
  const anchor = last ? last.seat : state.trick.leader;
  const anchorPlayer = state.players[anchor];
  const leader =
    anchorPlayer && isPlayablePlayer(anchorPlayer) ? anchor : nextAnyPlayableSeat(state, anchor);
  if (leader === null) return { ...state, turn: -1 };
  events.push({ type: 'trickWon', seat: anchor, newTrickLeader: leader });
  return {
    ...state,
    turn: leader,
    trick: { id: state.trick.id + 1, leader, lastPlay: null, passed: [], playCount: 0 },
  };
}

function settleAfterAction(state: GameState, events: GameEvent[]): GameState {
  return advanceFrom(state, state.turn, events);
}

function advanceFrom(state: GameState, from: number, events: GameEvent[]): GameState {
  if (isTrickComplete(state)) return startNextTrick(state, events);
  const next = nextPlayableSeat(state, from);
  if (next === null) return startNextTrick(state, events);
  return { ...state, turn: next };
}

/** Sau khi một ghế bị loại: giữ turn hợp lệ và đóng vòng nếu đã đủ người pass. */
function repairAfterRemoval(state: GameState, events: GameEvent[]): GameState {
  if (isTrickComplete(state)) return startNextTrick(state, events);
  const turnPlayer = state.players[state.turn];
  const turnUsable =
    turnPlayer !== undefined &&
    isPlayablePlayer(turnPlayer) &&
    !state.trick.passed.includes(state.turn);
  if (turnUsable) return state;
  const next = nextPlayableSeat(state, state.turn);
  if (next === null) return startNextTrick(state, events);
  return { ...state, turn: next };
}

function beatContext(state: GameState): BeatContext {
  return {
    order: state.order,
    combos: state.rules.combos,
    chatHeo: state.rules.chatHeo,
    scoring: state.rules.scoring,
  };
}

function chopTargetOf(combo: Combo, order: CardOrder): ChopTarget | null {
  if (combo.kind === 'rac' && combo.highest.rank === order.topRank) return 'singleTwo';
  if (combo.kind === 'doi' && combo.highest.rank === order.topRank) return 'pairTwo';
  if (combo.kind === 'tuQuy' || combo.kind === 'baDoiThong' || combo.kind === 'bonDoiThong') {
    return combo.kind;
  }
  return null;
}

function openChopWindow(
  state: GameState,
  combo: Combo,
  cards: readonly Card[],
  seat: number,
  actionId: string,
  nowMs: number,
): ChopWindowState | null {
  const config = state.rules.chatNgoaiLuot;
  if (!config.enabled) return null;
  const target = chopTargetOf(combo, state.order);
  if (!target || !config.opensOn.includes(target)) return null;
  return {
    openAt: nowMs,
    closesAt: nowMs + config.windowMs,
    targetActionId: actionId,
    targetCards: cards,
    targetBy: seat,
  };
}

function clearExpiredWindow(state: GameState, nowMs: number, events: GameEvent[]): GameState {
  const window = state.chopWindow;
  if (!window || nowMs <= window.closesAt) return state;
  events.push({ type: 'chopWindowClose', reason: 'timeout' });
  return { ...state, chopWindow: null };
}

/** Thứ tự tranh chấp cùng ms §2.5.4: ghế gần lượt kế tiếp sau người bị chặt thắng (số nhỏ hơn). */
export function chopPriority(state: GameState, targetBy: number, seat: number): number {
  const next = (targetBy + 1) % state.playerCount;
  return (seat - next + state.playerCount) % state.playerCount;
}

function* combinations<T>(items: readonly T[], size: number): Generator<T[]> {
  const picked: T[] = [];
  function* walk(start: number): Generator<T[]> {
    if (picked.length === size) {
      yield [...picked];
      return;
    }
    for (let index = start; index <= items.length - (size - picked.length); index += 1) {
      const item = items[index];
      if (item === undefined) continue;
      picked.push(item);
      yield* walk(index + 1);
      picked.pop();
    }
  }
  yield* walk(0);
}

/** Tại lúc pass, tay còn ít nhất một nước đè được `previous` hay không (log `couldBeat`). */
function hasLegalBeat(
  hand: readonly Card[],
  previous: Combo,
  context: BeatContext,
): boolean {
  const sizes = new Set<number>([previous.size, 4, 6, 8]);
  for (const size of sizes) {
    if (size <= 0 || size > hand.length) continue;
    for (const cards of combinations(hand, size)) {
      if (canBeat(previous, cards, context).ok) return true;
    }
  }
  return false;
}

function seatFailure(state: GameState, seat: number): ApplyResult | null {
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.playerCount) {
    return failure(state, 'NOT_IN_GAME', `ghế không hợp lệ: ${String(seat)}`, seat);
  }
  const player = state.players[seat];
  if (!player) return failure(state, 'NOT_IN_GAME', `ghế không tồn tại: ${seat}`, seat);
  if (player.hand.length === 0) {
    return failure(state, 'PLAYER_OUT', `ghế ${seat} đã hết bài`, seat);
  }
  if (state.trick.passed.includes(seat)) {
    return failure(state, 'ALREADY_PASSED', `ghế ${seat} đã pass trong vòng này`, seat);
  }
  if (player.surrendered) {
    return failure(state, 'PLAYER_OUT', `ghế ${seat} đã xin hàng`, seat);
  }
  if (player.denOut === true) {
    return failure(state, 'PLAYER_OUT', `ghế ${seat} đã ra khỏi ván vì đền 13 lá`, seat);
  }
  if (state.turn !== seat) {
    return failure(
      state,
      'NOT_YOUR_TURN',
      `chưa tới lượt ghế ${seat} (đang là ${state.turn})`,
      seat,
    );
  }
  return null;
}

function handlePlay(
  state: GameState,
  intent: Extract<Intent, { type: 'play' }>,
  nowMs: number,
): ApplyResult {
  const seatError = seatFailure(state, intent.seat);
  if (seatError) return seatError;
  const player = state.players[intent.seat];
  if (!player) return failure(state, 'NOT_IN_GAME', `ghế không tồn tại: ${intent.seat}`, intent.seat);

  if (!Array.isArray(intent.cards) || intent.cards.length === 0) {
    return failure(state, 'INVALID_CARDS', 'nước đánh phải có ít nhất 1 lá', intent.seat);
  }
  const cards = resolveHandCards(player.hand, intent.cards);
  if (!cards) {
    return failure(
      state,
      'CARD_NOT_IN_HAND',
      'có lá không nằm trên tay hoặc bị lặp',
      intent.seat,
    );
  }
  if (!state.firstPlayDone && state.firstMustContain3S && !containsPrimary(cards, state.rules.firstPlayer)) {
    return failure(
      state,
      'FIRST_MUST_CONTAIN_3S',
      'lượt đầu phải đánh bộ chứa 3♠',
      intent.seat,
    );
  }

  const combo = classifyCombo(cards, state.order, state.rules.combos);
  if (!combo) return failure(state, 'INVALID_COMBO', 'bộ bài không hợp lệ', intent.seat);

  const previous = state.trick.lastPlay;
  let beat: BeatResult | null = null;
  if (previous) {
    const result = canBeat(previous.combo, combo, beatContext(state));
    if (!result.ok) {
      return failure(state, 'INVALID_BEAT', `không đè được: ${result.reason}`, intent.seat, result.reason);
    }
    beat = result;
  }
  const isChop = previous !== null && beat?.kind === 'chop';

  const events: GameEvent[] = [];
  const base = clearExpiredWindow(state, nowMs, events);
  if (base.chopWindow) {
    events.push({ type: 'chopWindowClose', reason: 'nextAction' });
  }

  const actionId = `a${base.actionCount + 1}`;
  const playedIds = new Set(cards.map((card) => card.id));
  const players = base.players.map((entry) =>
    entry.seat === intent.seat
      ? { ...entry, hand: entry.hand.filter((card) => !playedIds.has(card.id)) }
      : entry,
  );
  const historyEntry: GameHistoryEntry =
    isChop && previous
      ? {
          type: 'chop',
          actionId,
          seat: intent.seat,
          trickId: base.trick.id,
          cards,
          combo,
          targetActionId: previous.actionId,
          targetBy: previous.seat,
          points: beat?.points ?? null,
          chop: beat?.chop ?? null,
        }
      : {
          type: 'play',
          actionId,
          seat: intent.seat,
          trickId: base.trick.id,
          cards,
          combo,
          auto: intent.auto === true,
        };
  const updated: GameState = {
    ...base,
    players,
    actionCount: base.actionCount + 1,
    lastActionId: actionId,
    lastNowMs: nowMs,
    firstPlayDone: true,
    chopWindow: null,
    lastChop:
      isChop && previous
        ? {
            actionId,
            seat: intent.seat,
            cards,
            combo,
            targetActionId: previous.actionId,
            targetBy: previous.seat,
            atMs: nowMs,
          }
        : base.lastChop,
    history: [...base.history, historyEntry],
    trick: {
      ...base.trick,
      lastPlay: { actionId, seat: intent.seat, cards, combo },
      playCount: base.trick.playCount + 1,
    },
  };
  if (isChop && previous) {
    events.push({
      type: 'chop',
      seat: intent.seat,
      actionId,
      cards,
      combo,
      targetActionId: previous.actionId,
    });
  } else {
    events.push({ type: 'play', seat: intent.seat, actionId, cards, combo });
  }

  if ((players[intent.seat]?.hand.length ?? 0) === 0) {
    const finished = finalizeRanking(recordFinish(updated, intent.seat), events);
    if (finished.phase === 'finished') return { state: finished, events, error: null };
    return { state: settleAfterAction(finished, events), events, error: null };
  }

  const window = openChopWindow(updated, combo, cards, intent.seat, actionId, nowMs);
  if (window) {
    events.push({ type: 'chopWindowOpen', window });
  }
  return {
    state: settleAfterAction({ ...updated, chopWindow: window }, events),
    events,
    error: null,
  };
}

function handlePass(
  state: GameState,
  intent: Extract<Intent, { type: 'pass' }>,
  nowMs: number,
): ApplyResult {
  const seatError = seatFailure(state, intent.seat);
  if (seatError) return seatError;
  if (!state.trick.lastPlay) {
    return failure(
      state,
      'CANNOT_PASS_WHEN_LEADING',
      'đang mở vòng, phải đánh chứ không được pass',
      intent.seat,
    );
  }
  const events: GameEvent[] = [];
  const base = clearExpiredWindow(state, nowMs, events);
  if (base.chopWindow) {
    events.push({ type: 'chopWindowClose', reason: 'nextAction' });
  }
  const player = state.players[intent.seat];
  const lastPlay = state.trick.lastPlay;
  const couldBeat =
    player !== undefined && lastPlay !== null
      ? hasLegalBeat(player.hand, lastPlay.combo, beatContext(state))
      : false;
  const auto = intent.auto === true;
  const actionId = `a${base.actionCount + 1}`;
  const updated: GameState = {
    ...base,
    actionCount: base.actionCount + 1,
    lastActionId: actionId,
    lastNowMs: nowMs,
    chopWindow: null,
    history: [
      ...base.history,
      {
        type: 'pass',
        actionId,
        seat: intent.seat,
        trickId: base.trick.id,
        auto,
        couldBeat,
      },
    ],
    trick: { ...base.trick, passed: [...base.trick.passed, intent.seat] },
  };
  events.push({ type: 'pass', seat: intent.seat, auto });
  return { state: settleAfterAction(updated, events), events, error: null };
}

function handleSurrender(
  state: GameState,
  intent: Extract<Intent, { type: 'surrender' }>,
  nowMs: number,
): ApplyResult {
  if (!Number.isInteger(intent.seat) || intent.seat < 0 || intent.seat >= state.playerCount) {
    return failure(state, 'NOT_IN_GAME', `ghế không hợp lệ: ${String(intent.seat)}`, intent.seat);
  }
  const player = state.players[intent.seat];
  if (!player) return failure(state, 'NOT_IN_GAME', `ghế không tồn tại: ${intent.seat}`, intent.seat);
  if (player.hand.length === 0) {
    return failure(state, 'PLAYER_OUT', `ghế ${intent.seat} đã hết bài`, intent.seat);
  }
  if (player.surrendered) {
    return failure(state, 'ALREADY_SURRENDERED', `ghế ${intent.seat} đã xin hàng`, intent.seat);
  }
  if (player.denOut === true) {
    return failure(state, 'PLAYER_OUT', `ghế ${intent.seat} đã ra khỏi ván vì đền 13 lá`, intent.seat);
  }

  const events: GameEvent[] = [];
  const base = clearExpiredWindow(state, nowMs, events);
  const players = base.players.map((entry) =>
    entry.seat === intent.seat ? { ...entry, surrendered: true } : entry,
  );
  events.push({ type: 'surrender', seat: intent.seat });
  // §1.7: người rời nhận hạng thấp nhất còn lại tại thời điểm rời; các ghế khác chơi tiếp.
  let updated: GameState = {
    ...base,
    players,
    actionCount: base.actionCount + 1,
    lastActionId: `a${base.actionCount + 1}`,
    lastNowMs: nowMs,
    history: [
      ...base.history,
      { type: 'surrender', actionId: `a${base.actionCount + 1}`, seat: intent.seat },
    ],
  };
  const remaining = remainingPlaces(updated);
  const lowest = remaining[remaining.length - 1];
  if (lowest) updated = addPlacement(updated, intent.seat, lowest);

  const finalized = finalizeRanking(updated, events);
  if (finalized.phase === 'finished') {
    return { state: finalized, events, error: null };
  }
  updated = finalized;

  // §3.3 + §1.3: người giữ 3♠ rời ván trước nước đầu → tính lại người đi trước
  // trong các ghế còn chơi (3♠ → 3♣ → 3♦ → 3♥ → lá thấp nhất).
  let next = updated;
  if (!updated.firstPlayDone && updated.firstMustContain3S && intent.seat === state.startingPlayerIndex) {
    const resolved = resolveStartingPlayer(
      updated.players.map((entry) => (entry.surrendered ? [] : entry.hand)),
      updated.order,
      updated.rules.firstPlayer,
    );
    next = {
      ...updated,
      startingPlayerIndex: resolved.playerIndex,
      firstMustContain3S: resolved.firstMustContain3S,
      turn: resolved.playerIndex,
      trick: { ...updated.trick, leader: resolved.playerIndex },
    };
  }
  return { state: repairAfterRemoval(next, events), events, error: null };
}

function handleChop(
  state: GameState,
  intent: Extract<Intent, { type: 'chop' }>,
  nowMs: number,
): ApplyResult {
  const { seat } = intent;
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.playerCount) {
    return failure(state, 'NOT_IN_GAME', `ghế không hợp lệ: ${String(seat)}`, seat);
  }
  const player = state.players[seat];
  if (!player) return failure(state, 'NOT_IN_GAME', `ghế không tồn tại: ${seat}`, seat);
  if (player.surrendered || player.hand.length === 0) {
    return failure(state, 'NOT_IN_GAME', `ghế ${seat} không còn trong ván`, seat);
  }

  const window = state.chopWindow;
  if (!window || nowMs > window.closesAt) {
    return failure(state, 'WINDOW_CLOSED', 'không có cửa sổ chặt đang mở', seat);
  }
  if (intent.targetActionId !== window.targetActionId) {
    if (state.lastChop && state.lastChop.targetActionId === intent.targetActionId) {
      return failure(state, 'LOST_RACE', 'đã có người chặt mục tiêu này trước', seat);
    }
    return failure(
      state,
      'INVALID_TARGET',
      `targetActionId không khớp cửa sổ (${window.targetActionId})`,
      seat,
    );
  }
  if (seat === window.targetBy) {
    return failure(state, 'INVALID_TARGET', 'không được chặt nước mình vừa đánh', seat);
  }
  if (state.rules.chatNgoaiLuot.passedCannotChop && state.trick.passed.includes(seat)) {
    return failure(state, 'ALREADY_PASSED', `ghế ${seat} đã pass trong vòng này`, seat);
  }
  if (!Array.isArray(intent.cards) || intent.cards.length === 0) {
    return failure(state, 'INVALID_CARDS', 'nước chặt phải có ít nhất 1 lá', seat);
  }
  const cards = resolveHandCards(player.hand, intent.cards);
  if (!cards) {
    return failure(state, 'CARD_NOT_IN_HAND', 'có lá không nằm trên tay hoặc bị lặp', seat);
  }
  const combo = classifyCombo(cards, state.order, state.rules.combos);
  if (!combo) return failure(state, 'INVALID_COMBO', 'bộ bài không hợp lệ', seat);

  const targetCombo = state.trick.lastPlay?.combo;
  if (!targetCombo) {
    return failure(state, 'INVALID_TARGET', 'không còn nước mục tiêu', seat);
  }
  const beat = canBeat(targetCombo, combo, beatContext(state));
  if (!beat.ok) {
    return failure(state, 'INVALID_BEAT', `không chặt được: ${beat.reason}`, seat, beat.reason);
  }
  if (beat.kind !== 'chop') {
    return failure(state, 'INVALID_BEAT', 'bộ này không phải hàng chặt', seat, 'CHOP_REQUIRED');
  }

  const actionId = `a${state.actionCount + 1}`;
  const playedIds = new Set(cards.map((card) => card.id));
  const players = state.players.map((entry) =>
    entry.seat === seat
      ? { ...entry, hand: entry.hand.filter((card) => !playedIds.has(card.id)) }
      : entry,
  );
  const chopRecord: ChopRecord = {
    actionId,
    seat,
    cards,
    combo,
    targetActionId: window.targetActionId,
    targetBy: window.targetBy,
    atMs: nowMs,
  };
  const updated: GameState = {
    ...state,
    players,
    actionCount: state.actionCount + 1,
    lastActionId: actionId,
    lastNowMs: nowMs,
    chopWindow: null,
    lastChop: chopRecord,
    history: [
      ...state.history,
      {
        type: 'chop',
        actionId,
        seat,
        trickId: state.trick.id,
        cards,
        combo,
        targetActionId: window.targetActionId,
        targetBy: window.targetBy,
        points: beat.points,
        chop: beat.chop,
      },
    ],
    trick: {
      ...state.trick,
      lastPlay: { actionId, seat, cards, combo },
      playCount: state.trick.playCount + 1,
    },
  };
  const events: GameEvent[] = [
    { type: 'chopWindowClose', reason: 'chop' },
    { type: 'chop', seat, actionId, cards, combo, targetActionId: window.targetActionId },
  ];

  if ((players[seat]?.hand.length ?? 0) === 0) {
    const finished = finalizeRanking(recordFinish(updated, seat), events);
    if (finished.phase === 'finished') return { state: finished, events, error: null };
    return { state: advanceFrom(finished, seat, events), events, error: null };
  }

  const nextWindow = openChopWindow(updated, combo, cards, seat, actionId, nowMs);
  if (nextWindow) {
    events.push({ type: 'chopWindowOpen', window: nextWindow });
  }
  return {
    state: advanceFrom({ ...updated, chopWindow: nextWindow }, seat, events),
    events,
    error: null,
  };
}

export function applyIntent(
  state: GameState,
  intent: Intent,
  options: ApplyOptions = {},
): ApplyResult {
  const nowMs = options.nowMs ?? state.lastNowMs;
  if (state.phase !== 'playing') {
    return failure(state, 'GAME_OVER', 'ván đã kết thúc', intent.seat);
  }
  switch (intent.type) {
    case 'play':
      return handlePlay(state, intent, nowMs);
    case 'pass':
      return handlePass(state, intent, nowMs);
    case 'surrender':
      return handleSurrender(state, intent, nowMs);
    case 'chop':
      return handleChop(state, intent, nowMs);
    default:
      return failure(state, 'INVALID_INTENT', 'intent không hỗ trợ', null);
  }
}

export interface TimeoutOptions {
  readonly nowMs?: number;
}

/**
 * §3.1: giữa vòng → auto pass (`auto=true`); mở vòng → đánh lá thấp nhất.
 * §2.5.6: đang mở `chopWindow` thì timer tạm dừng (khi `pauseTurnTimer=true`).
 */
export function applyTimeout(state: GameState, options: TimeoutOptions = {}): ApplyResult {
  const nowMs = options.nowMs ?? state.lastNowMs;
  if (state.phase !== 'playing') {
    return failure(state, 'GAME_OVER', 'ván đã kết thúc', state.turn);
  }
  const window = state.chopWindow;
  if (
    window &&
    state.rules.chatNgoaiLuot.pauseTurnTimer &&
    nowMs <= window.closesAt
  ) {
    return failure(state, 'TURN_PAUSED', 'timer tạm dừng trong chopWindow', state.turn);
  }

  // §1.7: lượt/timeout không bao giờ trỏ vào ghế đã hết bài / đã rời.
  const events: GameEvent[] = [];
  let base = state;
  const turnPlayer = state.players[state.turn];
  const turnUsable =
    turnPlayer !== undefined &&
    isPlayablePlayer(turnPlayer) &&
    !state.trick.passed.includes(state.turn);
  if (!turnUsable) {
    const repaired = finalizeRanking(repairAfterRemoval(state, events), events);
    if (repaired.phase === 'finished') {
      return { state: repaired, events, error: null };
    }
    if (repaired.turn < 0) {
      return failure(repaired, 'NOT_IN_GAME', 'không còn ghế nào đánh được', null);
    }
    const repairedPlayer = repaired.players[repaired.turn];
    if (repairedPlayer === undefined || !isPlayablePlayer(repairedPlayer)) {
      return failure(repaired, 'NOT_IN_GAME', 'không còn ghế nào đánh được', null);
    }
    base = repaired;
  }

  if (!base.trick.lastPlay && !timeoutLeadAllowed(base)) {
    return failure(
      base,
      'LEAD_AUTO_DISABLED',
      'cấu hình không cho auto đánh khi mở vòng',
      base.turn,
    );
  }

  const result = base.trick.lastPlay
    ? handlePass(base, { type: 'pass', seat: base.turn, auto: true }, nowMs)
    : autoPlayLowest(base, nowMs);
  return { state: result.state, events: [...events, ...result.events], error: result.error };
}

/**
 * doc-4 §4.2: hết giờ ở lượt dẫn ván ≥ 2 → auto lá thấp nhất (tự do, không ràng buộc 3♠).
 * Ván 1 giữ luật cũ theo `turn.autoPlayLowestWhenLeading`.
 */
function timeoutLeadAllowed(state: GameState): boolean {
  if (state.firstMoveFree) {
    return state.rules.firstPlayerSubsequent?.timeoutLeadPlaysLowest !== false;
  }
  return state.rules.turn?.autoPlayLowestWhenLeading !== false;
}

function autoPlayLowest(state: GameState, nowMs: number): ApplyResult {
  const player = state.players[state.turn];
  if (!player) return failure(state, 'NOT_IN_GAME', 'ghế tới lượt không tồn tại', state.turn);
  const lowest = [...player.hand].sort((a, b) => state.order.compare(a, b))[0];
  if (!lowest) {
    return failure(state, 'NOT_IN_GAME', 'ghế tới lượt không còn bài', state.turn);
  }
  return handlePlay(state, { type: 'play', seat: state.turn, cards: [lowest], auto: true }, nowMs);
}

export function createGame(options: CreateGameOptions): GameState {
  const { seed, players, rules } = options;
  if (!Number.isInteger(players) || players < 2 || players > 4) {
    throw new RangeError(`players không hợp lệ: ${String(players)}`);
  }
  const supported = rules.deal.playerCounts.map((row) => row.players);
  if (!supported.includes(players)) {
    throw new RangeError(`players ${players} không được hỗ trợ (${supported.join(', ')})`);
  }

  const order = createCardOrder(rules.deck);
  const roundIndex = options.roundIndex ?? 1;
  if (!Number.isInteger(roundIndex) || roundIndex < 1) {
    throw new RangeError(`roundIndex không hợp lệ: ${String(options.roundIndex)}`);
  }
  if (
    options.firstSeat !== undefined &&
    options.startingPlayerIndex !== undefined &&
    options.firstSeat !== options.startingPlayerIndex
  ) {
    throw new RangeError('firstSeat và startingPlayerIndex mâu thuẫn');
  }
  const forcedSeat = options.firstSeat ?? options.startingPlayerIndex;
  if (
    forcedSeat !== undefined &&
    (!Number.isInteger(forcedSeat) || forcedSeat < 0 || forcedSeat >= players)
  ) {
    throw new RangeError(`firstSeat không hợp lệ: ${String(forcedSeat)}`);
  }
  // doc-4 §4.2: ván ≥ 2 mới được đánh tự do; ván 1 giữ ràng buộc 3♠.
  const firstMoveFree =
    options.firstMoveFree ??
    (roundIndex >= 2 ? (rules.firstPlayerSubsequent?.firstMoveFree ?? true) : false);

  let hands: Card[][];
  let startingPlayerIndex: number;
  let firstMustContain3S: boolean;

  if (options.hands) {
    if (options.hands.length !== players) {
      throw new RangeError(`hands phải có đúng ${players} tay`);
    }
    hands = options.hands.map((hand, index) => {
      if (!Array.isArray(hand) || hand.length === 0) {
        throw new RangeError(`hands[${index}] phải có ít nhất 1 lá`);
      }
      return [...hand];
    });
    const seen = new Set<string>();
    for (const [index, hand] of hands.entries()) {
      if (hand.length === 0) {
        throw new RangeError(`hands[${index}] phải có ít nhất 1 lá`);
      }
      for (const card of hand) {
        if (seen.has(card.id)) throw new RangeError(`lá bị trùng giữa các tay: ${card.id}`);
        seen.add(card.id);
      }
    }
    if (forcedSeat !== undefined) {
      startingPlayerIndex = forcedSeat;
      const hand = hands[forcedSeat] ?? [];
      firstMustContain3S = rules.firstPlayer.mustContain3S && containsPrimary(hand, rules.firstPlayer);
    } else {
      const resolved = resolveStartingPlayer(hands, order, rules.firstPlayer);
      startingPlayerIndex = resolved.playerIndex;
      firstMustContain3S = resolved.firstMustContain3S;
    }
  } else {
    const dealt = dealCards(
      {
        deck: rules.deck,
        cardsPerPlayer: rules.deal.cardsPerPlayer,
        firstPlayer: rules.firstPlayer,
        supportedPlayers: supported,
      },
      players,
      seed,
    );
    hands = dealt.hands.map((hand) => [...hand]);
    startingPlayerIndex = dealt.startingPlayerIndex;
    firstMustContain3S = dealt.firstMustContain3S;
    // `startingPlayerIndex` cũ chỉ có tác dụng ở chế độ hands; `firstSeat` áp cho cả ván chia thật.
    if (options.firstSeat !== undefined) {
      startingPlayerIndex = options.firstSeat;
      firstMustContain3S =
        rules.firstPlayer.mustContain3S &&
        containsPrimary(hands[options.firstSeat] ?? [], rules.firstPlayer);
    }
  }
  if (firstMoveFree) firstMustContain3S = false;

  const playerStates: GamePlayer[] = hands.map((hand, seat) => ({
    seat,
    hand,
    surrendered: false,
  }));

  const base: GameState = {
    seed: normalizeSeed(seed),
    playerCount: players,
    rules,
    order,
    players: playerStates,
    phase: 'playing',
    turn: startingPlayerIndex,
    startingPlayerIndex,
    firstMustContain3S,
    firstMoveFree,
    roundIndex,
    firstPlayDone: false,
    trick: { id: 0, leader: startingPlayerIndex, lastPlay: null, passed: [], playCount: 0 },
    ranking: [],
    actionCount: 0,
    lastActionId: null,
    chopWindow: null,
    lastChop: null,
    history: [],
    lastNowMs: 0,
    toiTrang: null,
  };

  // §2.2: xét tới trắng ngay sau chia, trước nước đầu; ưu tiên thứ tự đi trước.
  const handSize = hands[0]?.length ?? 0;
  let toiTrang: ToiTrangInfo | null = null;
  if (rules.toiTrang.enabled) {
    const config = {
      enabled: true,
      combos: rules.toiTrang.combos,
      priority: rules.toiTrang.priority,
      handSize,
      sanh13LaLeDuocLaHai: rules.toiTrang.sanh13LaLeDuocLaHai,
      tuQuyDemHaiDoi: rules.toiTrang.tuQuyDemHaiDoi,
    };
    for (let step = 0; step < players; step += 1) {
      const seat = (startingPlayerIndex + step) % players;
      const result = detectToiTrang(hands[seat] ?? [], rules.deck, config);
      if (result) {
        toiTrang = { seat, combo: result.combo };
        break;
      }
    }
  }
  if (toiTrang) {
    const finished = finishGame({ ...base, toiTrang }, toiTrang.seat);
    return { ...finished, chopWindow: null };
  }
  return base;
}

