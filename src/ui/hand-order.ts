import type { CardView } from '../net/protocol';
import { sortCards } from './table-logic';

/** Thứ tự mặc định theo rules.deck (đã sort sẵn). */
export function defaultHandOrder(hand: readonly CardView[]): string[] {
  return sortCards(hand).map((card) => card.id);
}

/**
 * Giữ thứ tự thủ công của các lá còn trên tay, lá mới (nếu có) chèn theo thứ tự mặc định
 * ở cuối. Idempotent nên gọi lại mỗi lần render đều an toàn.
 */
export function reconcileHandOrder(
  order: readonly string[],
  hand: readonly CardView[],
): string[] {
  const handIds = new Set(hand.map((card) => card.id));
  const next: string[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    if (!handIds.has(id) || seen.has(id)) continue;
    next.push(id);
    seen.add(id);
  }
  for (const card of sortCards(hand)) {
    if (seen.has(card.id)) continue;
    next.push(card.id);
    seen.add(card.id);
  }
  return next;
}

/** Trả bài theo `order`; id lạ bị bỏ qua, lá thiếu order được append theo mặc định. */
export function orderedHand(
  hand: readonly CardView[],
  order: readonly string[],
): readonly CardView[] {
  if (order.length === 0) return sortCards(hand);
  const byId = new Map(hand.map((card) => [card.id, card]));
  const result: CardView[] = [];
  for (const id of order) {
    const card = byId.get(id);
    if (card === undefined) continue;
    result.push(card);
    byId.delete(id);
  }
  for (const card of sortCards([...byId.values()])) result.push(card);
  return result;
}

/**
 * Chuyển `cardId` tới `toIndex` trong danh sách đã bỏ lá đang kéo (0..n-1).
 * `toIndex` chính là vị trí cuối của lá sau khi chèn.
 */
export function moveCardTo(
  order: readonly string[],
  cardId: string,
  toIndex: number,
): string[] {
  const from = order.indexOf(cardId);
  if (from < 0) return [...order];
  const next = order.filter((id) => id !== cardId);
  const clamped = Math.min(Math.max(Math.trunc(toIndex), 0), next.length);
  next.splice(clamped, 0, cardId);
  return next;
}

/** Đổi vị trí ±1, dùng cho Alt+ArrowLeft/Right. */
export function moveCardBy(order: readonly string[], cardId: string, delta: number): string[] {
  const from = order.indexOf(cardId);
  if (from < 0 || delta === 0) return [...order];
  const to = Math.min(Math.max(from + delta, 0), order.length - 1);
  return moveCardTo(order, cardId, to);
}
