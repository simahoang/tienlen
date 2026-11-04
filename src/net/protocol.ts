import type { ComboKey, Rank, Suit } from '../rules/types';

/**
 * Giao thức JSON dùng chung client/server (M1 online).
 * Card id lấy đúng từ rule engine: `${rank}-${suit}` (vd "3-spades", "10-hearts").
 */

export const PROTOCOL_VERSION = 1;
export const MIN_SEATS = 2;
export const MAX_SEATS = 4;
export const ROOM_CODE_LENGTH = 5;
export const NICKNAME_MAX = 20;

const ROOM_CODE_PATTERN = /^[A-Z0-9]{4,6}$/;
const CARD_ID_PATTERN = /^(3|4|5|6|7|8|9|10|J|Q|K|A|2)-(spades|clubs|diamonds|hearts)$/;

export interface CardView {
  readonly id: string;
  readonly rank: Rank;
  readonly suit: Suit;
}

export interface RoomPlayerView {
  readonly seat: number;
  readonly nickname: string;
  readonly ready: boolean;
  readonly connected: boolean;
  readonly isHost: boolean;
}

export interface RoomView {
  readonly code: string;
  readonly hostSeat: number;
  readonly maxSeats: number;
  readonly phase: RoomPhase;
  readonly players: readonly RoomPlayerView[];
  /** Chỉ có ý nghĩa với người nhận message; token dùng cho reconnect (pha 2). */
  readonly you: { readonly seat: number; readonly token: string };
}

export type RoomPhase = 'lobby' | 'playing' | 'finished';

export interface StatePlayerView {
  readonly seat: number;
  readonly nickname: string;
  readonly cardsLeft: number;
  readonly ready: boolean;
  readonly connected: boolean;
  readonly surrendered: boolean;
}

export interface TableView {
  readonly cards: readonly CardView[];
  readonly seat: number;
  readonly actionId: string;
  readonly comboKind: ComboKey;
  readonly comboSize: number;
}

export interface RankingView {
  readonly seat: number;
  readonly place: 'nhat' | 'nhi' | 'ba' | 'bet';
  readonly cardsLeft: number;
}

export interface ChopWindowView {
  readonly openAt: number;
  readonly closesAt: number;
  readonly targetActionId: string;
  readonly targetCards: readonly CardView[];
  readonly targetBy: number;
}

/** Log công khai để reconnect dựng lại diễn biến; không chứa bài trên tay hay seed. */
export interface ActionLogView {
  readonly actionId: string;
  readonly seat: number;
  readonly type: 'play' | 'pass' | 'chop' | 'surrender';
  readonly cards: readonly CardView[];
  readonly auto: boolean;
  readonly targetActionId?: string;
}

/** Một khoản điểm thô từ engine (`calculateScore().breakdown`), chỉ gửi khi ván finished. */
export interface ScoreBreakdownView {
  readonly type: 'place' | 'toiTrang' | 'chop' | 'chatChong' | 'thoi' | 'denGiu13La';
  readonly from: number | null;
  readonly to: number | null;
  readonly points: number;
  readonly note?: string;
}

/** Phần state công khai — KHÔNG bao giờ chứa bài của người khác. */
export interface PublicGameState {
  readonly rulesVersion: string;
  readonly phase: RoomPhase;
  readonly turn: number;
  readonly players: readonly StatePlayerView[];
  readonly table: TableView | null;
  readonly trick: { readonly id: number; readonly leader: number; readonly passed: readonly number[] };
  readonly ranking: readonly RankingView[] | null;
  readonly scores: readonly number[] | null;
  /** Chỉ có khi phase finished; vắng mặt hoàn toàn khi đang chơi. */
  readonly breakdown?: readonly ScoreBreakdownView[];
  readonly turnDeadline: number | null;
  readonly chopWindow: ChopWindowView | null;
  readonly lastActionId: string | null;
  readonly serverNow: number;
}

export type ClientMessage =
  | { readonly t: 'createRoom'; readonly nickname: string }
  | { readonly t: 'joinRoom'; readonly code: string; readonly nickname: string }
  | { readonly t: 'ready'; readonly ready: boolean }
  | { readonly t: 'start' }
  | { readonly t: 'play'; readonly cards: readonly string[] }
  | { readonly t: 'pass' }
  | { readonly t: 'surrender' }
  | { readonly t: 'chop'; readonly cards: readonly string[]; readonly targetActionId: string }
  | { readonly t: 'reconnect'; readonly token: string };

export type ServerMessage =
  | { readonly t: 'room'; readonly room: RoomView }
  | {
      readonly t: 'state';
      readonly you: { readonly seat: number; readonly hand: readonly CardView[] };
      readonly state: PublicGameState;
      /** Chỉ gửi kèm khi reconnect (§3.2): log công khai từ đầu ván. */
      readonly actionLog?: readonly ActionLogView[];
    }
  | { readonly t: 'error'; readonly code: string; readonly message: string };

export type ParseResult =
  | { readonly ok: true; readonly message: ClientMessage }
  | { readonly ok: false; readonly code: string; readonly message: string };

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: string, message: string): ParseResult {
  return { ok: false, code, message };
}

function parseNickname(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const nickname = value.trim();
  if (nickname.length === 0 || nickname.length > NICKNAME_MAX) return null;
  // Loại ký tự điều khiển để log/UI không bị phá.
  if (/[\u0000-\u001f\u007f]/.test(nickname)) return null;
  return nickname;
}

function parseRoomCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return ROOM_CODE_PATTERN.test(code) ? code : null;
}

function parseCardIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 13) return null;
  const seen = new Set<string>();
  const cards: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !CARD_ID_PATTERN.test(item)) return null;
    if (seen.has(item)) return null;
    seen.add(item);
    cards.push(item);
  }
  return cards;
}

/** Validate thủ công (không thêm dependency): từ chối payload lạ, sai kiểu, sai shape. */
export function parseClientMessage(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail('INVALID_JSON', 'payload không phải JSON hợp lệ');
  }
  if (!isRecord(parsed)) return fail('INVALID_PAYLOAD', 'payload phải là JSON object');

  const t = parsed['t'];
  switch (t) {
    case 'createRoom': {
      const nickname = parseNickname(parsed['nickname']);
      if (!nickname) return fail('INVALID_NICKNAME', `nickname phải 1-${NICKNAME_MAX} ký tự`);
      return { ok: true, message: { t: 'createRoom', nickname } };
    }
    case 'joinRoom': {
      const code = parseRoomCode(parsed['code']);
      if (!code) return fail('INVALID_CODE', 'mã phòng phải 4-6 ký tự A-Z/0-9');
      const nickname = parseNickname(parsed['nickname']);
      if (!nickname) return fail('INVALID_NICKNAME', `nickname phải 1-${NICKNAME_MAX} ký tự`);
      return { ok: true, message: { t: 'joinRoom', code, nickname } };
    }
    case 'ready': {
      const ready = parsed['ready'];
      if (typeof ready !== 'boolean') return fail('INVALID_PAYLOAD', 'ready phải là boolean');
      return { ok: true, message: { t: 'ready', ready } };
    }
    case 'start':
      return { ok: true, message: { t: 'start' } };
    case 'play': {
      const cards = parseCardIds(parsed['cards']);
      if (!cards) return fail('INVALID_CARDS', 'cards phải là 1-13 card id duy nhất');
      return { ok: true, message: { t: 'play', cards } };
    }
    case 'pass':
      return { ok: true, message: { t: 'pass' } };
    case 'surrender':
      return { ok: true, message: { t: 'surrender' } };
    case 'chop': {
      const cards = parseCardIds(parsed['cards']);
      if (!cards) return fail('INVALID_CARDS', 'cards phải là 1-13 card id duy nhất');
      const targetActionId = parsed['targetActionId'];
      if (typeof targetActionId !== 'string' || !/^a[0-9]+$/.test(targetActionId)) {
        return fail('INVALID_TARGET', 'targetActionId không hợp lệ');
      }
      return { ok: true, message: { t: 'chop', cards, targetActionId } };
    }
    case 'reconnect': {
      const token = parsed['token'];
      if (typeof token !== 'string' || token.length < 16 || token.length > 128) {
        return fail('INVALID_TOKEN', 'token không hợp lệ');
      }
      return { ok: true, message: { t: 'reconnect', token } };
    }
    default:
      return fail('UNKNOWN_MESSAGE', `loại message không hỗ trợ: ${String(t)}`);
  }
}

export function cardView(id: string, rank: Rank, suit: Suit): CardView {
  return { id, rank, suit };
}
