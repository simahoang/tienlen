import { rules } from '../data/index';
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
/** Số khán giả tối đa mỗi phòng (doc-5 §4.1). */
export const MAX_SPECTATORS = 10;
/** Độ dài tối đa một tin chat (ký tự, sau khi trim/bỏ control chars). */
export const CHAT_MAX = 200;
/** Số tin chat giữ lại trong history của phòng. */
export const CHAT_HISTORY_MAX = 50;
/** Rate limit chat: tối đa `CHAT_RATE_MAX` tin / `CHAT_RATE_WINDOW_MS` mỗi account. */
export const CHAT_RATE_MAX = 5;
export const CHAT_RATE_WINDOW_MS = 5000;

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

export type RoomRole = 'player' | 'spectator';

/** Một hàng bảng xếp hạng tour live (panel trái). Không chứa account/token/hand. */
export interface LeaderboardRowView {
  readonly seat: number;
  readonly nickname: string;
  readonly pointsTotal: number;
  readonly wins: number;
  readonly roundsPlayed: number;
  /** true khi người này đã rời tour (ghế có thể đã được người khác dùng). */
  readonly left: boolean;
}

/** Một tin chat trong phòng; `role` cho client biết hiển thị badge khán giả/người chơi. */
export interface ChatMessageView {
  readonly id: string;
  readonly seat: number;
  readonly nickname: string;
  readonly role: RoomRole;
  readonly text: string;
  /** epoch ms server lúc nhận tin. */
  readonly at: number;
}

export interface RoomView {
  readonly code: string;
  readonly hostSeat: number;
  readonly maxSeats: number;
  readonly phase: RoomPhase;
  readonly players: readonly RoomPlayerView[];
  /** Thông tin tour của phòng; vắng mặt = phòng chưa mở tour (lobby cũ). */
  readonly tour?: TourView;
  /**
   * Bảng xếp hạng tour live cho panel trái; chỉ có khi phòng có tour.
   * Đã sắp sẵn (điểm desc, thắng desc, ghế asc); không chứa account/token/hand.
   */
  readonly leaderboard?: readonly LeaderboardRowView[];
  /** Số khán giả đang xem; vắng mặt = client cũ / phòng không có khán giả. */
  readonly spectatorCount?: number;
  /**
   * Chỉ có ý nghĩa với người nhận message; token dùng cho reconnect (pha 2).
   * Khán giả nhận `seat: -1` + `role: 'spectator'`; vắng `role` = người chơi (client cũ).
   */
  readonly you: { readonly seat: number; readonly token: string; readonly role?: RoomRole };
}

/** Một hàng danh sách phòng ở sảnh (doc-5 §3.1) — không chứa token/hand/tài khoản. */
export interface RoomSummaryView {
  readonly code: string;
  readonly hostNickname: string;
  readonly playerCount: number;
  readonly maxSeats: number;
  readonly phase: RoomPhase;
  readonly spectatorCount: number;
  /** Ván hiện tại/đã chơi gần nhất của tour; null khi phòng không có tour. */
  readonly roundIndex: number | null;
  /** Tổng số ván của tour; null khi phòng không có tour. */
  readonly soVan: number | null;
  /** true khi phase lobby và còn ghế trống (vào thẳng ghế được). */
  readonly canJoin: boolean;
}

export type RoomPhase = 'lobby' | 'playing' | 'finished';

/** doc-4 §3: vòng đời tour trong phòng. `betweenRounds` = KET_QUA_VAN đang đếm ngược. */
export type TourPhase = 'running' | 'betweenRounds' | 'paused' | 'finished';

export interface TourView {
  readonly tourId: string;
  /** Tổng số ván của tour (N). */
  readonly soVan: number;
  /** Ván hiện tại/đã chơi xong gần nhất, 1..N. */
  readonly roundIndex: number;
  readonly phase: TourPhase;
  /** Mốc auto chia ván mới (epoch ms) khi phase `betweenRounds`; null nếu không hẹn. */
  readonly nextRoundAt: number | null;
  /** true khi tour kết thúc sớm (chủ phòng dừng) — bảng tổng kết gắn cờ này. */
  readonly incomplete?: boolean;
}

export type TourRankPlace = 'nhat' | 'nhi' | 'ba' | 'bet';

/** Một hàng điểm tour (doc-4 §5.2). `place` là hạng ván vừa rồi (null nếu không xếp hạng). */
export interface TourScoreView {
  readonly seat: number;
  readonly nickname: string;
  readonly pointsTotal: number;
  /** Điểm ván vừa kết thúc (0 nếu người chơi không có mặt ván đó). */
  readonly roundPoints: number;
  readonly wins: number;
  readonly chatThu: number;
  readonly chatTra: number;
  /** chatThu − chatTra (gồm chặt chồng). */
  readonly netChat: number;
  readonly thoiTra: number;
  readonly denTra: number;
  readonly roundsPlayed: number;
  readonly joinedMid: boolean;
  readonly left: boolean;
  readonly lastPlace: TourRankPlace | null;
}

/** Bảng điểm sau mỗi ván + hẹn giờ chia ván kế (doc-4 §3.1). */
export interface TourResultView {
  readonly tourId: string;
  readonly roundIndex: number;
  readonly soVan: number;
  /** Ván kế tiếp (null khi vừa chơi ván cuối). */
  readonly nextRoundIndex: number | null;
  readonly nextRoundAt: number | null;
  /** Ghế đi trước ván kế (dự đoán theo ghế hiện tại; null khi hết tour). */
  readonly nextFirstSeat: number | null;
  readonly nextFirstNickname: string | null;
  readonly nextFirstMoveFree: boolean;
  readonly scores: readonly TourScoreView[];
}

/** Một hàng bảng tổng kết cuối tour, đã xếp hạng theo doc-4 §5.3. */
export interface TourEndRowView extends TourScoreView {
  readonly tourRank: number;
  readonly tourPlace: TourRankPlace;
}

export interface TourEndView {
  readonly tourId: string;
  readonly soVan: number;
  readonly roundsPlayed: number;
  readonly incomplete: boolean;
  readonly rows: readonly TourEndRowView[];
}

/** doc-4 §6: TAM_DUNG khi thiếu người để chia ván mới. */
export interface TourPausedView {
  readonly tourId: string;
  readonly roundIndex: number;
  readonly present: number;
  readonly needed: number;
  readonly reason: 'thieu_nguoi';
}

export interface StatePlayerView {
  readonly seat: number;
  readonly nickname: string;
  readonly cardsLeft: number;
  readonly ready: boolean;
  readonly connected: boolean;
  readonly surrendered: boolean;
  /**
   * true khi ghế đã chốt hạng (về Nhất/Nhì/Ba/Bét hoặc đã rời ván) — có thể xảy ra
   * ngay trong phase `playing` khi ván còn chơi tiếp. Vắng mặt = client cũ, hiểu là chưa về.
   */
  readonly placed?: boolean;
  /**
   * rev6 §1.7: ghế giữ đủ 13 lá khi đã có Nhất → ra khỏi ván ngay, không có hạng,
   * không bị thối, không còn lượt. Vắng mặt = client cũ, hiểu là chưa đền.
   */
  readonly denOut?: boolean;
}

/** Lý do ghế rời ván vì đền bài; M1 chỉ có giữ đủ 13 lá. */
export type DenBaiReason = 'GIU_13_LA';

/** Một lần đền 13 lá: `who` trả `points` cho `to` (người về Nhất). */
export interface DenBaiView {
  readonly who: number;
  readonly to: number;
  readonly points: number;
  readonly reason: DenBaiReason;
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
  /**
   * Hạng đã chốt, sắp từ Nhất xuống Bét. Khi phase `playing` mảng có thể rỗng hoặc
   * thiếu ghế (ai chưa về thì chưa có entry); chỉ đủ hạng khi phase `finished`.
   * `null` = chưa có ván nào.
   */
  readonly ranking: readonly RankingView[] | null;
  readonly scores: readonly number[] | null;
  /** Chỉ có khi phase finished; vắng mặt hoàn toàn khi đang chơi. */
  readonly breakdown?: readonly ScoreBreakdownView[];
  /**
   * Các ghế đã đền 13 lá (đang chơi hoặc đã xong), kèm điểm trừ theo đúng công thức
   * engine. Dùng cho reconnect/UI; vắng mặt = chưa có ai đền (client cũ vẫn chạy).
   */
  readonly denBai?: readonly DenBaiView[];
  readonly turnDeadline: number | null;
  readonly chopWindow: ChopWindowView | null;
  readonly lastActionId: string | null;
  /**
   * Bộ đánh ngay trước bộ đang dẫn trong CÙNG vòng (doc-5 §6) để client vẽ lớp mờ;
   * null khi đầu vòng/không có. Vắng mặt = client cũ.
   */
  readonly previousTable?: TableView | null;
  /** Ván thứ mấy trong tour (1..N); vắng mặt = client cũ / ván đơn. */
  readonly roundIndex?: number;
  /** true khi lượt đầu ván được đánh tự do (ván ≥ 2 của tour, doc-4 §4.2). */
  readonly firstMoveFree?: boolean;
  /** Ghế đi trước ván này; vắng mặt = client cũ. */
  readonly firstSeat?: number;
  readonly serverNow: number;
}

export type ClientMessage =
  | { readonly t: 'createRoom'; readonly nickname: string; readonly soVan?: number }
  | { readonly t: 'joinRoom'; readonly code: string; readonly nickname: string }
  /** Khán giả đang xem xin vào ghế trống (chỉ khi lobby, còn ghế, không tour active). */
  | { readonly t: 'joinSeat'; readonly code: string }
  /** Khán giả rời phòng, giữ socket để quay lại sảnh. */
  | { readonly t: 'leaveWatch' }
  /** Xin danh sách phòng đang mở (sảnh). */
  | { readonly t: 'listRooms' }
  | { readonly t: 'ready'; readonly ready: boolean }
  | { readonly t: 'start' }
  | { readonly t: 'play'; readonly cards: readonly string[] }
  | { readonly t: 'pass' }
  | { readonly t: 'surrender' }
  | { readonly t: 'chop'; readonly cards: readonly string[]; readonly targetActionId: string }
  /** Rời tour: bỏ điểm tour, trả ghế trống ngay (doc-4 §5.4). */
  | { readonly t: 'leaveTour' }
  /** Chủ phòng kết thúc sớm tour đang chạy (doc-4 §3.1). */
  | { readonly t: 'endTour' }
  /** Tour mới cùng ghế: tour_id mới, điểm từ 0. */
  | { readonly t: 'newTour'; readonly soVan?: number }
  /** Chat phòng: chỉ người chơi gửi được; server validate + rate limit + broadcast. */
  | { readonly t: 'chat'; readonly text: string }
  | { readonly t: 'reconnect'; readonly token: string };

export type ServerMessage =
  | { readonly t: 'room'; readonly room: RoomView }
  | {
      /** Danh sách phòng ở sảnh; server push khi có thay đổi hoặc trả lời `listRooms`. */
      readonly t: 'roomList';
      readonly rooms: readonly RoomSummaryView[];
      readonly serverNow: number;
    }
  | {
      readonly t: 'state';
      readonly you: { readonly seat: number; readonly hand: readonly CardView[] };
      readonly state: PublicGameState;
      /** Chỉ gửi kèm khi reconnect (§3.2): log công khai từ đầu ván. */
      readonly actionLog?: readonly ActionLogView[];
    }
  | {
      /** Một ghế vừa bị chốt đền (rev6 §1.7); broadcast ngay cho cả phòng. */
      readonly t: 'denBai';
      readonly event: DenBaiView;
      readonly serverNow: number;
    }
  | {
      /** Ván vừa quyết toán: bảng điểm ván + điểm tour cộng dồn + hẹn 10s. */
      readonly t: 'tourResult';
      readonly result: TourResultView;
      readonly serverNow: number;
    }
  | { readonly t: 'tourPaused'; readonly paused: TourPausedView; readonly serverNow: number }
  | { readonly t: 'tourEnd'; readonly summary: TourEndView; readonly serverNow: number }
  /** Một tin chat mới, broadcast cho người chơi + khán giả trong phòng. */
  | { readonly t: 'chat'; readonly message: ChatMessageView }
  /** Lịch sử chat (tối đa CHAT_HISTORY_MAX) gửi khi join/reconnect. */
  | { readonly t: 'chatHistory'; readonly messages: readonly ChatMessageView[] }
  /** Người chơi đã rời tour và được detach khỏi phòng; client về sảnh. */
  | { readonly t: 'leftTour' }
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

/** Chat: trim, bỏ control chars, phải còn 1..CHAT_MAX ký tự; null = không hợp lệ. */
function parseChatText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (text.length === 0 || text.length > CHAT_MAX) return null;
  return text;
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

/** `null` = không gửi (dùng mặc định); `'invalid'` = sai kiểu/khoảng (trả lỗi rõ ràng). */
function parseTourCount(value: unknown): number | null | 'invalid' {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) return 'invalid';
  const { min, max } = rules.tour;
  if (value < min || value > max) return 'invalid';
  return value;
}

export function tourCountError(): string {
  const { min, max } = rules.tour;
  return `số ván phải là số nguyên từ ${min} đến ${max}`;
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
      const soVan = parseTourCount(parsed['soVan']);
      if (soVan === 'invalid') return fail('INVALID_TOUR_COUNT', tourCountError());
      return {
        ok: true,
        message: { t: 'createRoom', nickname, ...(soVan === null ? {} : { soVan }) },
      };
    }
    case 'newTour': {
      const soVan = parseTourCount(parsed['soVan']);
      if (soVan === 'invalid') return fail('INVALID_TOUR_COUNT', tourCountError());
      return { ok: true, message: { t: 'newTour', ...(soVan === null ? {} : { soVan }) } };
    }
    case 'joinRoom': {
      const code = parseRoomCode(parsed['code']);
      if (!code) return fail('INVALID_CODE', 'mã phòng phải 4-6 ký tự A-Z/0-9');
      const nickname = parseNickname(parsed['nickname']);
      if (!nickname) return fail('INVALID_NICKNAME', `nickname phải 1-${NICKNAME_MAX} ký tự`);
      return { ok: true, message: { t: 'joinRoom', code, nickname } };
    }
    case 'joinSeat': {
      const code = parseRoomCode(parsed['code']);
      if (!code) return fail('INVALID_CODE', 'mã phòng phải 4-6 ký tự A-Z/0-9');
      return { ok: true, message: { t: 'joinSeat', code } };
    }
    case 'leaveWatch':
      return { ok: true, message: { t: 'leaveWatch' } };
    case 'listRooms':
      return { ok: true, message: { t: 'listRooms' } };
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
    case 'leaveTour':
      return { ok: true, message: { t: 'leaveTour' } };
    case 'endTour':
      return { ok: true, message: { t: 'endTour' } };
    case 'chat': {
      const text = parseChatText(parsed['text']);
      if (!text) return fail('INVALID_CHAT', `tin nhắn phải 1-${CHAT_MAX} ký tự`);
      return { ok: true, message: { t: 'chat', text } };
    }
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
