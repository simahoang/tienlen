import { classifyCombo, type Combo, type ComboRulesMap } from './combos';
import type { CardOrder } from './deck';
import type { Card, ChopAttacker, ChopTarget, Suit } from './types';

export interface ChopHeoLike {
  readonly enabled: boolean;
  readonly matrix: Readonly<
    Partial<Record<ChopAttacker, Readonly<Partial<Record<ChopTarget, boolean>>>>>
  >;
}

/** Bảng giá trị §2.4: dùng cho chặt / thối / đền. */
export interface ScoreValuesLike {
  readonly values: {
    readonly heoDen: number;
    readonly heoDo: number;
    readonly baDoiThong: number;
    readonly tuQuy: number;
    readonly bonDoiThong: number;
  };
}

export interface BeatContext {
  readonly order: CardOrder;
  readonly combos: ComboRulesMap;
  readonly chatHeo: ChopHeoLike;
  readonly scoring?: ScoreValuesLike;
}

export type BeatKind = 'free' | 'normal' | 'chop';

export type BeatReason =
  | 'OK_FREE'
  | 'OK_NORMAL'
  | 'OK_CHOP'
  | 'INVALID_COMBO'
  | 'KIND_MISMATCH'
  | 'SIZE_MISMATCH'
  | 'NOT_HIGHER'
  | 'CHOP_NOT_ALLOWED';

export interface BeatResult {
  readonly ok: boolean;
  readonly kind: BeatKind | null;
  readonly reason: BeatReason;
  readonly chop: { readonly attacker: ChopAttacker; readonly target: ChopTarget } | null;
  readonly points: number | null;
}

function isCards(input: Combo | readonly Card[]): input is readonly Card[] {
  return Array.isArray(input);
}

function resolveCombo(input: Combo | readonly Card[], context: BeatContext): Combo | null {
  return isCards(input) ? classifyCombo(input, context.order, context.combos) : input;
}

function fail(reason: BeatReason): BeatResult {
  return { ok: false, kind: null, reason, chop: null, points: null };
}

function ok(kind: BeatKind, reason: BeatReason): BeatResult {
  return { ok: true, kind, reason, chop: null, points: null };
}

const ATTACKER_KINDS: readonly ChopAttacker[] = ['baDoiThong', 'tuQuy', 'bonDoiThong'];

function attackerOf(combo: Combo): ChopAttacker | null {
  return (ATTACKER_KINDS as readonly string[]).includes(combo.kind)
    ? (combo.kind as ChopAttacker)
    : null;
}

function targetOf(combo: Combo, order: CardOrder): ChopTarget | null {
  if (combo.kind === 'rac' && combo.highest.rank === order.topRank) return 'singleTwo';
  if (combo.kind === 'doi' && combo.highest.rank === order.topRank) return 'pairTwo';
  if (combo.kind === 'baDoiThong' || combo.kind === 'tuQuy' || combo.kind === 'bonDoiThong') {
    return combo.kind;
  }
  return null;
}

const BLACK_SUITS: ReadonlySet<Suit> = new Set<Suit>(['spades', 'clubs']);

function heoValue(card: Card, values: ScoreValuesLike['values']): number {
  return BLACK_SUITS.has(card.suit) ? values.heoDen : values.heoDo;
}

/** §2.4: chặt 1 heo = giá trị lá; đôi heo = tổng 2 lá; 3ĐT/TQ/4ĐT = 3/4/6. */
function chopValue(
  target: ChopTarget,
  previous: Combo,
  values: ScoreValuesLike['values'],
): number {
  switch (target) {
    case 'singleTwo':
      return heoValue(previous.highest, values);
    case 'pairTwo':
      return previous.cards.reduce((sum, card) => sum + heoValue(card, values), 0);
    case 'baDoiThong':
      return values.baDoiThong;
    case 'tuQuy':
      return values.tuQuy;
    case 'bonDoiThong':
      return values.bonDoiThong;
  }
}

/**
 * `previous = null` (hoặc mảng rỗng) = mở vòng, đánh tự do.
 * Trả `reason` để server map sang `INVALID_BEAT`; `kind` phân biệt đè thường và chặt.
 */
export function canBeat(
  previous: Combo | readonly Card[] | null,
  next: Combo | readonly Card[],
  context: BeatContext,
): BeatResult {
  const nextCombo = resolveCombo(next, context);
  if (!nextCombo) return fail('INVALID_COMBO');

  const isFree = previous === null || (isCards(previous) && previous.length === 0);
  if (isFree) return ok('free', 'OK_FREE');

  const previousCombo = resolveCombo(previous, context);
  if (!previousCombo) return fail('INVALID_COMBO');

  const attacker = attackerOf(nextCombo);
  const target = targetOf(previousCombo, context.order);
  if (attacker !== null && target !== null) {
    const allowed = context.chatHeo.enabled && context.chatHeo.matrix[attacker]?.[target] === true;
    if (allowed) {
      if (attacker === previousCombo.kind) {
        const higher = context.order.compare(nextCombo.highest, previousCombo.highest) > 0;
        if (!higher) return fail('NOT_HIGHER');
      }
      const points = context.scoring
        ? chopValue(target, previousCombo, context.scoring.values)
        : null;
      return {
        ok: true,
        kind: 'chop',
        reason: 'OK_CHOP',
        chop: { attacker, target },
        points,
      };
    }
    if (attacker !== previousCombo.kind) return fail('CHOP_NOT_ALLOWED');
  }

  if (previousCombo.kind !== nextCombo.kind) return fail('KIND_MISMATCH');
  if (previousCombo.size !== nextCombo.size) return fail('SIZE_MISMATCH');
  const higher = context.order.compare(nextCombo.highest, previousCombo.highest) > 0;
  return higher ? ok('normal', 'OK_NORMAL') : fail('NOT_HIGHER');
}
