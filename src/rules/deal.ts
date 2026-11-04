import { createCardOrder, createDeck, type CardOrder } from './deck';
import { mulberry32, normalizeSeed, shuffle } from './rng';
import type { Card, DeckConfig, StartingPlayerConfig } from './types';

export interface DealConfig {
  readonly deck: DeckConfig;
  readonly cardsPerPlayer: number;
  readonly firstPlayer: StartingPlayerConfig;
  readonly supportedPlayers: readonly number[];
}

export interface StartingPlayerResult {
  readonly playerIndex: number;
  readonly card: Card;
  /** true chỉ khi người đi trước thật sự giữ 3♠ và luật bắt buộc đang bật. */
  readonly firstMustContain3S: boolean;
  readonly rejectCode: string | null;
}

export interface DealResult {
  readonly seed: number;
  readonly playerCount: number;
  readonly handSize: number;
  readonly hands: readonly (readonly Card[])[];
  readonly deadCards: readonly Card[];
  readonly startingPlayerIndex: number;
  readonly startingCard: Card;
  readonly firstMustContain3S: boolean;
  readonly rejectCode: string | null;
}

/**
 * §1.3: 3♠ → 3♣ → 3♦ → 3♥ → lá thấp nhất. Chỉ khi tìm được 3♠ mới bắt buộc
 * lượt đầu chứa 3♠; fallback thì lượt đầu đánh tự do.
 */
export function resolveStartingPlayer(
  hands: readonly (readonly Card[])[],
  order: CardOrder,
  config: StartingPlayerConfig,
): StartingPlayerResult {
  const candidateSuits = [config.primaryCard.suit, ...config.fallbackSuits];
  for (const suit of candidateSuits) {
    for (let playerIndex = 0; playerIndex < hands.length; playerIndex += 1) {
      const hand = hands[playerIndex] ?? [];
      const found = hand.find(
        (card) => card.rank === config.primaryCard.rank && card.suit === suit,
      );
      if (found) {
        const isPrimary = suit === config.primaryCard.suit;
        return {
          playerIndex,
          card: found,
          firstMustContain3S: isPrimary && config.mustContain3S,
          rejectCode: isPrimary && config.mustContain3S ? (config.rejectCode ?? null) : null,
        };
      }
    }
  }

  let lowestPlayer = -1;
  let lowestCard: Card | null = null;
  for (let playerIndex = 0; playerIndex < hands.length; playerIndex += 1) {
    const hand = hands[playerIndex] ?? [];
    for (const card of hand) {
      if (lowestCard === null || order.compare(card, lowestCard) < 0) {
        lowestCard = card;
        lowestPlayer = playerIndex;
      }
    }
  }
  if (lowestCard === null || lowestPlayer < 0) {
    throw new Error('resolveStartingPlayer: không có lá bài nào trên tay');
  }
  return {
    playerIndex: lowestPlayer,
    card: lowestCard,
    firstMustContain3S: false,
    rejectCode: null,
  };
}

export function dealCards(config: DealConfig, playerCount: number, seed: number): DealResult {
  if (!Number.isInteger(playerCount) || playerCount < 1) {
    throw new RangeError(`playerCount không hợp lệ: ${String(playerCount)}`);
  }
  if (!config.supportedPlayers.includes(playerCount)) {
    throw new RangeError(
      `playerCount ${playerCount} không được hỗ trợ (chỉ ${config.supportedPlayers.join(', ')} người)`,
    );
  }
  const handSize = config.cardsPerPlayer;
  if (!Number.isInteger(handSize) || handSize < 1) {
    throw new RangeError(`cardsPerPlayer không hợp lệ: ${String(handSize)}`);
  }

  const deck = createDeck(config.deck);
  if (playerCount * handSize > deck.length) {
    throw new RangeError(
      `không đủ bài: ${playerCount} người x ${handSize} lá > ${deck.length} lá`,
    );
  }

  const normalizedSeed = normalizeSeed(seed);
  const shuffled = shuffle(deck, mulberry32(normalizedSeed));
  const hands: Card[][] = [];
  for (let playerIndex = 0; playerIndex < playerCount; playerIndex += 1) {
    const start = playerIndex * handSize;
    hands.push(shuffled.slice(start, start + handSize));
  }
  const deadCards = shuffled.slice(playerCount * handSize);
  const starting = resolveStartingPlayer(
    hands,
    createCardOrder(config.deck),
    config.firstPlayer,
  );

  return {
    seed: normalizedSeed,
    playerCount,
    handSize,
    hands,
    deadCards,
    startingPlayerIndex: starting.playerIndex,
    startingCard: starting.card,
    firstMustContain3S: starting.firstMustContain3S,
    rejectCode: starting.rejectCode,
  };
}
