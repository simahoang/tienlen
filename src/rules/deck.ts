import type { Card, DeckConfig, Rank, Suit } from './types';

export interface CardOrder {
  readonly topRank: Rank;
  readonly rankIndex: (rank: Rank) => number;
  readonly suitIndex: (suit: Suit) => number;
  /** < 0 nếu a yếu hơn b, > 0 nếu mạnh hơn, 0 nếu cùng lá. */
  readonly compare: (a: Card, b: Card) => number;
}

export function makeCardId(rank: Rank, suit: Suit): string {
  return `${rank}-${suit}`;
}

export function createDeck(config: DeckConfig): Card[] {
  const deck: Card[] = [];
  for (const suit of config.suits) {
    for (const rank of config.ranks) {
      deck.push({ id: makeCardId(rank, suit), rank, suit });
    }
  }
  return deck;
}

export function createCardOrder(config: DeckConfig): CardOrder {
  const rankIndex = new Map<Rank, number>();
  config.ranks.forEach((rank, index) => {
    rankIndex.set(rank, index);
  });
  const suitIndex = new Map<Suit, number>();
  config.suits.forEach((suit, index) => {
    suitIndex.set(suit, index);
  });

  const indexOfRank = (rank: Rank): number => {
    const index = rankIndex.get(rank);
    if (index === undefined) {
      throw new Error(`rank không có trong deck.ranks: ${rank}`);
    }
    return index;
  };
  const indexOfSuit = (suit: Suit): number => {
    const index = suitIndex.get(suit);
    if (index === undefined) {
      throw new Error(`suit không có trong deck.suits: ${suit}`);
    }
    return index;
  };

  const topRank = config.ranks[config.ranks.length - 1];
  if (topRank === undefined) {
    throw new Error('deck.ranks rỗng');
  }

  return {
    topRank,
    rankIndex: indexOfRank,
    suitIndex: indexOfSuit,
    compare: (a, b) => {
      const byRank = indexOfRank(a.rank) - indexOfRank(b.rank);
      if (byRank !== 0) return byRank;
      return indexOfSuit(a.suit) - indexOfSuit(b.suit);
    },
  };
}

/** Sắp tay bài từ mạnh đến yếu (2♥ trước, 3♠ sau). */
export function sortHand(cards: readonly Card[], order: CardOrder): Card[] {
  return [...cards].sort((a, b) => order.compare(b, a));
}

export function groupByRank(cards: readonly Card[]): Map<Rank, Card[]> {
  const groups = new Map<Rank, Card[]>();
  for (const card of cards) {
    const group = groups.get(card.rank);
    if (group) {
      group.push(card);
    } else {
      groups.set(card.rank, [card]);
    }
  }
  return groups;
}
