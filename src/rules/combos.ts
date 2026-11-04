import { groupByRank, type CardOrder } from './deck';
import type { Card, ComboKey, Rank } from './types';

export type ComboKind =
  | 'rac'
  | 'doi'
  | 'samCo'
  | 'sanh'
  | 'tuQuy'
  | 'baDoiThong'
  | 'bonDoiThong';

export interface ComboSpecLike {
  readonly cards?: number;
  readonly minCards?: number;
  readonly maxCards?: number;
  readonly noTwo?: boolean;
  readonly playable?: boolean;
}

/** Hình dạng tối thiểu của `rules.combos`; đọc từ data, không hard-code kích thước. */
export type ComboRulesMap = Readonly<Partial<Record<ComboKey, ComboSpecLike>>>;

export interface Combo {
  readonly kind: ComboKind;
  readonly cards: readonly Card[];
  readonly size: number;
  /** Lá mạnh nhất theo rank rồi chất (sảnh: lá cao nhất; đôi thông: lá cao nhất của đôi cao nhất). */
  readonly highest: Card;
  readonly ranks: readonly Rank[];
}

function specOf(combos: ComboRulesMap, key: ComboKey): ComboSpecLike {
  const spec = combos[key];
  if (!spec) throw new Error(`rules.combos thiếu cấu hình "${key}"`);
  return spec;
}

function highestCard(cards: readonly Card[], order: CardOrder): Card {
  let highest = cards[0];
  if (highest === undefined) throw new Error('combo rỗng');
  for (const card of cards) {
    if (order.compare(card, highest) > 0) highest = card;
  }
  return highest;
}

function isConsecutivePairs(
  cards: readonly Card[],
  pairCount: number,
  order: CardOrder,
): boolean {
  const groups = groupByRank(cards);
  if (groups.size !== pairCount) return false;
  for (const group of groups.values()) {
    if (group.length !== 2) return false;
  }
  const indices = [...groups.keys()].map((rank) => order.rankIndex(rank)).sort((a, b) => a - b);
  for (let i = 1; i < indices.length; i += 1) {
    const current = indices[i];
    const previous = indices[i - 1];
    if (current === undefined || previous === undefined || current !== previous + 1) return false;
  }
  return true;
}

function isStraight(cards: readonly Card[], spec: ComboSpecLike, order: CardOrder): boolean {
  const minCards = spec.minCards ?? 3;
  const maxCards = spec.maxCards ?? Infinity;
  if (cards.length < minCards || cards.length > maxCards) return false;

  const ranks = [...new Set(cards.map((card) => card.rank))];
  if (ranks.length !== cards.length) return false;
  if (spec.noTwo !== false && ranks.includes(order.topRank)) return false;

  const indices = ranks.map((rank) => order.rankIndex(rank)).sort((a, b) => a - b);
  for (let i = 1; i < indices.length; i += 1) {
    const current = indices[i];
    const previous = indices[i - 1];
    if (current === undefined || previous === undefined || current !== previous + 1) return false;
  }
  return true;
}

function buildCombo(
  kind: ComboKind,
  cards: readonly Card[],
  order: CardOrder,
): Combo {
  return {
    kind,
    cards,
    size: cards.length,
    highest: highestCard(cards, order),
    ranks: [...new Set(cards.map((card) => card.rank))],
  };
}

/**
 * Phân loại bộ theo §1.4. Trả null nếu không phải bộ đánh hợp lệ.
 * 5 đôi thông (kể cả khi cấu hình `playable=false`) trả null.
 */
export function classifyCombo(
  cards: readonly Card[],
  order: CardOrder,
  combos: ComboRulesMap,
): Combo | null {
  if (cards.length === 0) return null;
  if (new Set(cards.map((card) => card.id)).size !== cards.length) return null;

  const uniqueRanks = new Set(cards.map((card) => card.rank));
  const allSameRank = uniqueRanks.size === 1;

  for (const kind of ['rac', 'doi', 'samCo', 'tuQuy'] as const) {
    const spec = specOf(combos, kind);
    if (cards.length === spec.cards && (kind === 'rac' || allSameRank)) {
      return buildCombo(kind, cards, order);
    }
  }

  const pairKinds = [
    ['baDoiThong', 'baDoiThong', 3],
    ['bonDoiThong', 'bonDoiThong', 4],
  ] as const;
  for (const [configKey, kind, pairs] of pairKinds) {
    const spec = specOf(combos, configKey);
    if (cards.length !== spec.cards) continue;
    if (!isConsecutivePairs(cards, pairs, order)) continue;
    if (spec.playable === false) return null;
    return buildCombo(kind, cards, order);
  }

  if (isStraight(cards, specOf(combos, 'sanh'), order)) {
    return buildCombo('sanh', cards, order);
  }

  return null;
}
