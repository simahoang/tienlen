import type { CardOrder } from './deck';
import type { GameHistoryEntry, GameState } from './game';
import type { Card, Rank, Suit } from './types';

export type ScoreEventType =
  | 'place'
  | 'toiTrang'
  | 'chop'
  | 'chatChong'
  | 'thoi'
  | 'denGiu13La';

export interface ScoreBreakdownEntry {
  readonly type: ScoreEventType;
  readonly from: number | null;
  readonly to: number | null;
  readonly points: number;
  readonly note: string;
}

export interface ScoreResult {
  readonly deltas: readonly number[];
  readonly breakdown: readonly ScoreBreakdownEntry[];
  readonly toiTrang: boolean;
}

export type ScoreValues = GameState['rules']['scoring']['values'];

const BLACK_SUITS: ReadonlySet<Suit> = new Set<Suit>(['spades', 'clubs']);

/** §2.4: heo đen (♠/♣) 1 điểm, heo đỏ (♦/♥) 2 điểm. */
export function heoValue(card: Card, values: ScoreValues): number {
  return BLACK_SUITS.has(card.suit) ? values.heoDen : values.heoDo;
}

function applyTransfer(
  deltas: number[],
  breakdown: ScoreBreakdownEntry[],
  from: number,
  to: number,
  points: number,
  type: ScoreEventType,
  note: string,
): void {
  if (points === 0 || from === to) return;
  const fromDelta = deltas[from];
  const toDelta = deltas[to];
  if (fromDelta === undefined || toDelta === undefined) return;
  deltas[from] = fromDelta - points;
  deltas[to] = toDelta + points;
  breakdown.push({ type, from, to, points, note });
}

/**
 * §2.4 thối: mỗi heo còn tay = giá trị lá (đen 1 / đỏ 2); mỗi hàng còn tay
 * = 3ĐT 3 / TQ 4 / 4ĐT 6. Tứ quý heo đã tính theo từng lá 2, không cộng thêm TQ.
 */
export function thoiPoints(
  hand: readonly Card[],
  order: CardOrder,
  values: ScoreValues,
): number {
  const topRank = order.topRank;
  let amount = 0;
  const counts = new Map<Rank, number>();

  for (const card of hand) {
    if (card.rank === topRank) {
      // M1 bật tới trắng tứ quý 2 (§2.2) → 4 lá 2 không bao giờ tới scoring;
      // nhánh này chỉ gặp 1-3 heo còn tay. Heo tính từng lá (đen 1 / đỏ 2) và
      // không xét như tứ quý để tránh double-count.
      amount += heoValue(card, values);
      continue;
    }
    counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  }

  const pairRanks: number[] = [];
  for (const [rank, count] of counts) {
    if (count >= 4) {
      amount += values.tuQuy;
      continue;
    }
    if (count >= 2) pairRanks.push(order.rankIndex(rank));
  }
  pairRanks.sort((a, b) => a - b);

  let index = 0;
  while (index < pairRanks.length) {
    let end = index;
    while (end + 1 < pairRanks.length && pairRanks[end + 1] === pairRanks[end]! + 1) {
      end += 1;
    }
    const length = end - index + 1;
    amount += Math.floor(length / 4) * values.bonDoiThong;
    if (length % 4 >= 3) amount += values.baDoiThong;
    index = end + 1;
  }
  return amount;
}

function chopChains(history: readonly GameHistoryEntry[]): Extract<GameHistoryEntry, { type: 'chop' }>[][] {
  const chains: Extract<GameHistoryEntry, { type: 'chop' }>[][] = [];
  const chainOf = new Map<string, number>();
  for (const entry of history) {
    if (entry.type !== 'chop') continue;
    if (entry.points === null || entry.chop === null) continue;
    const parent = chainOf.get(entry.targetActionId);
    if (parent === undefined) {
      chains.push([entry]);
      chainOf.set(entry.actionId, chains.length - 1);
    } else {
      chains[parent]?.push(entry);
      chainOf.set(entry.actionId, parent);
    }
  }
  return chains;
}

/**
 * §2.4 (rulesVersion 1.2.0):
 * - Hạng cộng dồn từ tour chung theo số người, KHÔNG zero-sum, không dồn lệch.
 * - Tới trắng +6, ván dừng, các nhà còn lại 0 hạng.
 * - Chặt = giá trị mục tiêu; chặt chồng (DEN-2) quyết toán ròng bằng giá trị
 *   mục tiêu ĐẦU chuỗi.
 * - Thối theo bảng giá trị; đền 13 lá = 4 + tổng giá trị heo/hàng trên tay,
 *   người đền không tính thối riêng.
 */
export function calculateScore(state: GameState): ScoreResult {
  if (state.phase !== 'finished') {
    throw new Error('calculateScore: ván chưa kết thúc');
  }
  const deltas = new Array<number>(state.playerCount).fill(0);
  const breakdown: ScoreBreakdownEntry[] = [];
  const scoring = state.rules.scoring;

  if (state.toiTrang) {
    const winner = state.toiTrang.seat;
    const amount = scoring.toiTrang.points;
    if (amount !== 0 && deltas[winner] !== undefined) {
      deltas[winner] += amount;
      breakdown.push({ type: 'toiTrang', from: null, to: winner, points: amount, note: 'tới trắng' });
    }
    return { deltas, breakdown, toiTrang: true };
  }

  for (const placement of state.ranking) {
    const value = scoring.places[placement.place] ?? 0;
    if (value !== 0 && deltas[placement.seat] !== undefined) {
      deltas[placement.seat] = (deltas[placement.seat] ?? 0) + value;
    }
    breakdown.push({
      type: 'place',
      from: null,
      to: placement.seat,
      points: value,
      note: placement.place,
    });
  }

  const winner = state.ranking[0]?.seat;
  if (winner === undefined) {
    return { deltas, breakdown, toiTrang: false };
  }

  // Chặt + chặt chồng: chuỗi >= 2 khoản → DEN-2 ròng, chỉ đền giá trị mục tiêu đầu chuỗi.
  const denBai = state.rules.denBai;
  const chainGanh = denBai?.chatChongGanhChuoi ?? true;
  for (const chain of chopChains(state.history)) {
    const first = chain[0];
    const last = chain[chain.length - 1];
    if (!first || !last) continue;
    if (chain.length === 1 || !chainGanh) {
      for (const entry of chain) {
        const label = entry.chop
          ? `${entry.chop.attacker} chặt ${entry.chop.target}`
          : 'chặt';
        applyTransfer(
          deltas,
          breakdown,
          entry.targetBy,
          entry.seat,
          entry.points ?? 0,
          'chop',
          label,
        );
      }
      continue;
    }
    const theoGiaTriDauChuoi = denBai?.chatChongTheoGiaTriMucTieu ?? true;
    const points = theoGiaTriDauChuoi
      ? (first.points ?? 0)
      : chain.reduce((sum, entry) => sum + (entry.points ?? 0), 0);
    applyTransfer(deltas, breakdown, first.seat, last.seat, points, 'chatChong', 'chặt chồng (DEN-2)');
  }

  // Đền 13 lá: còn đủ 13 lá khi có Nhất → trả 4 + tổng giá trị heo/hàng trên tay.
  const denSeats = new Set<number>();
  if (denBai?.enabled ?? true) {
    const fullHand = state.rules.deal.cardsPerPlayer;
    for (const player of state.players) {
      if (player.seat === winner || player.surrendered) continue;
      if (player.hand.length !== fullHand) continue;
      const extra = thoiPoints(player.hand, state.order, scoring.values);
      const points = scoring.den.giu13La + extra;
      denSeats.add(player.seat);
      applyTransfer(deltas, breakdown, player.seat, winner, points, 'denGiu13La', 'đền 13 lá');
    }
  }

  // Thối heo/hàng còn tay khi có Nhất; người đền 13 lá không tính thối riêng.
  for (const player of state.players) {
    if (player.seat === winner) continue;
    if (denSeats.has(player.seat)) continue;
    const amount = thoiPoints(player.hand, state.order, scoring.values);
    applyTransfer(deltas, breakdown, player.seat, winner, amount, 'thoi', 'thối heo/hàng');
  }

  return { deltas, breakdown, toiTrang: false };
}
