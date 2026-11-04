import { groupByRank } from './deck';
import type { Card, DeckConfig, Rank, ToiTrangCombo } from './types';

export interface ToiTrangConfig {
  readonly enabled: boolean;
  readonly combos: readonly ToiTrangCombo[];
  readonly priority: readonly ToiTrangCombo[];
  readonly handSize: number;
  /** §2.2 rev 4: lá lẻ thứ 13 của sảnh 3→A được là 2. */
  readonly sanh13LaLeDuocLaHai?: boolean | undefined;
  /** §2.2 rev 4: tứ quý đếm là 2 đôi khi xét "6 đôi bất kỳ". */
  readonly tuQuyDemHaiDoi?: boolean | undefined;
}

export interface ToiTrangResult {
  readonly combo: ToiTrangCombo;
  readonly hand: readonly Card[];
}

type RankCounts = ReadonlyMap<Rank, readonly Card[]>;

function countPairs(counts: RankCounts, tuQuyDemHaiDoi: boolean): number {
  let pairs = 0;
  for (const cards of counts.values()) {
    pairs += tuQuyDemHaiDoi
      ? Math.floor(cards.length / 2)
      : Math.min(cards.length, 2) >= 2
        ? 1
        : 0;
  }
  return pairs;
}

function hasConsecutivePairs(
  counts: RankCounts,
  pairCount: number,
  ranks: readonly Rank[],
): boolean {
  for (let start = 0; start + pairCount <= ranks.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < pairCount; offset += 1) {
      const rank = ranks[start + offset];
      if (rank === undefined || (counts.get(rank)?.length ?? 0) < 2) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function matches(
  combo: ToiTrangCombo,
  counts: RankCounts,
  deck: DeckConfig,
  topRank: Rank | undefined,
  config: ToiTrangConfig,
): boolean {
  switch (combo) {
    case 'sanh3toA': {
      const hasAllRanks = deck.ranks.every((rank) => rank === topRank || counts.has(rank));
      if (!hasAllRanks) return false;
      if (config.sanh13LaLeDuocLaHai ?? true) return true;
      // Flag tắt: lá lẻ thứ 13 không được là 2 → phải đủ 13 lá không phải heo.
      let nonTwo = 0;
      for (const [rank, cards] of counts) {
        if (rank !== topRank) nonTwo += cards.length;
      }
      return nonTwo === config.handSize;
    }
    case 'namDoiThong':
      return hasConsecutivePairs(counts, 5, deck.ranks);
    case 'sauDoiThong':
      return hasConsecutivePairs(counts, 6, deck.ranks);
    case 'sauDoiBatKy':
      return countPairs(counts, config.tuQuyDemHaiDoi ?? true) >= 6;
    case 'tuQuyHai':
      return topRank !== undefined && (counts.get(topRank)?.length ?? 0) >= 4;
    default:
      return false;
  }
}

/**
 * §2.2 — chỉ xét ngay sau chia, trước nước đầu. Trả tổ hợp ưu tiên cao nhất
 * theo `priority` (đã chốt trong rules.json: 6 đôi thông trước 5 đôi thông và
 * trước 6 đôi bất kỳ). KHÔNG dùng 5 đôi thông làm bộ đánh.
 */
export function detectToiTrang(
  hand: readonly Card[],
  deck: DeckConfig,
  config: ToiTrangConfig,
): ToiTrangResult | null {
  if (!config.enabled) return null;
  if (hand.length === 0 || hand.length !== config.handSize) return null;

  const counts = groupByRank(hand);
  const topRank = deck.ranks[deck.ranks.length - 1];
  const enabled = new Set(config.combos);

  for (const combo of config.priority) {
    if (!enabled.has(combo)) continue;
    if (matches(combo, counts, deck, topRank, config)) {
      return { combo, hand };
    }
  }
  return null;
}
