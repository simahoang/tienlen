import { rules } from '../data';
import type { CardView, ChopWindowView, PublicGameState } from '../net/protocol';
import { classifyCombo, type Combo } from '../rules/combos';
import { canBeat, type BeatReason } from '../rules/compare';
import { createCardOrder, sortHand } from '../rules/deck';
import type { Card, Rank } from '../rules/types';
import { computeRemainingMs } from './timer';

const ORDER = createCardOrder(rules.deck);
const BEAT_CONTEXT = {
  order: ORDER,
  combos: rules.combos,
  chatHeo: rules.chatHeo,
};

const COMBO_LABELS: Readonly<Record<Combo['kind'], string>> = {
  rac: 'Rác',
  doi: 'Đôi',
  samCo: 'Sám cô',
  sanh: 'Sảnh',
  tuQuy: 'Tứ quý',
  baDoiThong: '3 đôi thông',
  bonDoiThong: '4 đôi thông',
};

const BEAT_REASON_HINTS: Readonly<Record<BeatReason, string>> = {
  OK_FREE: 'Đánh tự do.',
  OK_NORMAL: 'Đè được nước trên bàn.',
  OK_CHOP: 'Chặt được nước trên bàn.',
  INVALID_COMBO: 'Các lá đã chọn không tạo thành bộ hợp lệ.',
  KIND_MISMATCH: 'Phải đánh cùng loại bộ với nước trên bàn.',
  SIZE_MISMATCH: 'Phải đánh cùng số lá với nước trên bàn.',
  NOT_HIGHER: 'Bộ này chưa lớn hơn nước trên bàn.',
  CHOP_NOT_ALLOWED: 'Không được chặt nước này.',
};

export interface SelectionResult {
  readonly selected: readonly CardView[];
  readonly combo: Combo | null;
  readonly playable: boolean;
  readonly hint: string;
}

export function toggleSelection(selected: ReadonlySet<string>, cardId: string): Set<string> {
  const next = new Set(selected);
  if (next.has(cardId)) next.delete(cardId);
  else next.add(cardId);
  return next;
}

export function pickCards(
  hand: readonly CardView[],
  selectedIds: ReadonlySet<string>,
): readonly CardView[] {
  return hand.filter((card) => selectedIds.has(card.id));
}

export function sortCards(cards: readonly CardView[]): readonly CardView[] {
  return sortHand(cards, ORDER);
}

function isYourTurn(state: PublicGameState, youSeat: number): boolean {
  return state.phase === 'playing' && state.turn === youSeat && state.chopWindow === null;
}

/** Ghế của bạn đã chốt hạng/đã rời ván → không còn quyền đánh, bỏ lượt hay xin hàng. */
function isSelfPlaced(state: PublicGameState, youSeat: number): boolean {
  const self = state.players.find((player) => player.seat === youSeat);
  return self?.placed === true;
}

export function evaluateSelection(
  hand: readonly CardView[],
  selectedIds: ReadonlySet<string>,
  state: PublicGameState | null,
  youSeat: number,
): SelectionResult {
  const selected = pickCards(hand, selectedIds);
  const combo = selected.length > 0 ? classifyCombo(selected, ORDER, rules.combos) : null;

  if (state === null || state.phase !== 'playing') {
    return { selected, combo, playable: false, hint: 'Ván chưa bắt đầu hoặc đã kết thúc.' };
  }
  if (isSelfPlaced(state, youSeat)) {
    return { selected, combo, playable: false, hint: 'Bạn đã về, chờ ván kết thúc.' };
  }
  if (state.chopWindow !== null) {
    return { selected, combo, playable: false, hint: 'Cửa sổ chặt đang mở.' };
  }
  if (state.turn !== youSeat) {
    return { selected, combo, playable: false, hint: 'Chưa tới lượt của bạn.' };
  }
  if (selected.length === 0) {
    return { selected, combo, playable: false, hint: 'Chọn bài để đánh.' };
  }
  if (combo === null) {
    return {
      selected,
      combo,
      playable: false,
      hint: 'Các lá đã chọn không tạo thành bộ hợp lệ.',
    };
  }

  const label = COMBO_LABELS[combo.kind];
  if (state.table === null) {
    return { selected, combo, playable: true, hint: `${label} · đánh tự do.` };
  }

  const beat = canBeat(state.table.cards, selected, BEAT_CONTEXT);
  return {
    selected,
    combo,
    playable: beat.ok,
    hint: beat.ok
      ? `${label} · ${BEAT_REASON_HINTS[beat.reason]}`
      : BEAT_REASON_HINTS[beat.reason],
  };
}

export function canPassTurn(state: PublicGameState | null, youSeat: number): boolean {
  return state !== null && isYourTurn(state, youSeat) && state.table !== null;
}

export function canSurrender(state: PublicGameState | null, youSeat: number): boolean {
  if (state === null || state.phase !== 'playing') return false;
  const self = state.players.find((player) => player.seat === youSeat);
  return self !== undefined && !self.surrendered && self.placed !== true;
}

/** Server từ chối intent chặt (WINDOW_CLOSED/LOST_RACE/...) thì mở khoá nút để bấm lại. */
export function resetChopAttempt(
  sentFor: string | null,
  errorCode: string | null,
): string | null {
  return sentFor !== null && errorCode !== null ? null : sentFor;
}

export interface ChopOffer {
  readonly cards: readonly CardView[];
  readonly label: string;
}

export interface ChopDecision {
  readonly offer: ChopOffer | null;
  readonly remainingMs: number;
  readonly visible: boolean;
}

function pairRuns(hand: readonly CardView[], length: number): CardView[][] {
  const byRank = new Map<Rank, CardView[]>();
  for (const card of hand) {
    const group = byRank.get(card.rank);
    if (group) group.push(card);
    else byRank.set(card.rank, [card]);
  }
  const pairs = [...byRank.entries()]
    .filter(([, cards]) => cards.length >= 2)
    .map(([rank, cards]) => ({ index: ORDER.rankIndex(rank), cards }))
    .sort((a, b) => a.index - b.index);

  const runs: CardView[][] = [];
  for (let start = 0; start + length <= pairs.length; start += 1) {
    const window = pairs.slice(start, start + length);
    const consecutive = window.every(
      (entry, offset) => offset === 0 || entry.index === (window[offset - 1]?.index ?? -2) + 1,
    );
    if (!consecutive) continue;
    runs.push(window.flatMap((entry) => entry.cards.slice(0, 2)));
  }
  return runs;
}

function chopCandidates(hand: readonly CardView[]): CardView[][] {
  const fours: CardView[][] = [];
  const byRank = new Map<Rank, CardView[]>();
  for (const card of hand) {
    const group = byRank.get(card.rank);
    if (group) group.push(card);
    else byRank.set(card.rank, [card]);
  }
  for (const cards of byRank.values()) {
    if (cards.length === 4) fours.push(cards);
  }
  return [...pairRuns(hand, 3), ...fours, ...pairRuns(hand, 4)];
}

export function findChopCandidate(
  hand: readonly CardView[],
  window: ChopWindowView | null,
  youSeat: number,
  passed: readonly number[],
): ChopOffer | null {
  if (window === null) return null;
  if (window.targetBy === youSeat) return null;
  if (passed.includes(youSeat)) return null;
  for (const cards of chopCandidates(hand)) {
    const combo = classifyCombo(cards as readonly Card[], ORDER, rules.combos);
    if (!combo) continue;
    if (
      (combo.kind === 'baDoiThong' || combo.kind === 'tuQuy' || combo.kind === 'bonDoiThong') &&
      canBeat(window.targetCards, cards, BEAT_CONTEXT).ok
    ) {
      return { cards, label: COMBO_LABELS[combo.kind] };
    }
  }
  return null;
}

export function decideChop(
  window: ChopWindowView | null,
  hand: readonly CardView[],
  serverNow: number,
  receivedAt: number,
  now: number,
  youSeat: number,
  passed: readonly number[],
): ChopDecision {
  if (window === null) return { offer: null, remainingMs: 0, visible: false };
  const remainingMs = computeRemainingMs(window.closesAt, serverNow, receivedAt, now);
  if (remainingMs <= 0) return { offer: null, remainingMs: 0, visible: false };
  const offer = findChopCandidate(hand, window, youSeat, passed);
  return { offer, remainingMs, visible: offer !== null };
}
