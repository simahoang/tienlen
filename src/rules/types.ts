/**
 * Kiểu lá bài dùng chung cho rule engine. Thứ tự rank/chất KHÔNG nằm ở đây —
 * lấy từ `data/rules.json` để không hard-code luật.
 */
export type Suit = 'spades' | 'clubs' | 'diamonds' | 'hearts';

export type Rank =
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | '10'
  | 'J'
  | 'Q'
  | 'K'
  | 'A'
  | '2';

export type ComboKey =
  | 'rac'
  | 'doi'
  | 'samCo'
  | 'sanh'
  | 'tuQuy'
  | 'baDoiThong'
  | 'bonDoiThong'
  | 'namDoiThong';

export type ChopAttacker = 'baDoiThong' | 'tuQuy' | 'bonDoiThong';

export type ChopTarget = 'singleTwo' | 'pairTwo' | 'baDoiThong' | 'tuQuy' | 'bonDoiThong';

export type ToiTrangCombo =
  | 'sanh3toA'
  | 'namDoiThong'
  | 'sauDoiThong'
  | 'sauDoiBatKy'
  | 'tuQuyHai';

export interface Card {
  readonly id: string;
  readonly rank: Rank;
  readonly suit: Suit;
}

export interface DeckConfig {
  readonly ranks: readonly Rank[];
  readonly suits: readonly Suit[];
}

export interface StartingPlayerConfig {
  readonly mustContain3S: boolean;
  readonly primaryCard: { readonly rank: Rank; readonly suit: Suit };
  readonly fallbackSuits: readonly Suit[];
  readonly rejectCode?: string;
}

/** Hạng dùng cho fallback "ai đi trước ván ≥ 2" (doc-4 §4.3): Nhì → Ba → Bét. */
export type FallbackPlace = 'nhi' | 'ba' | 'bet';

/** doc-4 §4.2/§4.3 — ván 2+ của tour. Đọc từ `data/rules.json#firstPlayerSubsequent`. */
export interface FirstPlayerSubsequentConfig {
  /** true: người hạng Nhất ván trước đi trước. */
  readonly winnerLeads: boolean;
  /** true: lượt đầu ván ≥ 2 đánh tự do (không bắt buộc chứa 3♠). */
  readonly firstMoveFree: boolean;
  /** `highestPlacedPresent` = hạng cao nhất còn trong phòng. */
  readonly fallback: string;
  /** Thứ tự fallback khi Nhất ván trước vắng mặt. */
  readonly fallbackOrder?: readonly FallbackPlace[];
  /** true: ghế mới vào giữa tour (chưa có hạng ván trước) xếp sau cùng. */
  readonly newSeatLast?: boolean;
  /** `seat0`: không còn ai có hạng thì ghế chủ phòng đi trước. */
  readonly emptyFallback?: string;
  /** true: hết giờ ở lượt dẫn ván ≥ 2 → auto đánh lá thấp nhất (tự do). */
  readonly timeoutLeadPlaysLowest?: boolean;
  readonly rejectCode?: string | null;
}
