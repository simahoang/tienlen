import { rules } from '../data';
import type {
  DenBaiView,
  TourEndView,
  TourPausedView,
  TourRankPlace,
  TourResultView,
  TourScoreView,
  TourView,
} from '../net/protocol';
import { computeRemainingMs } from './timer';

/** doc-4 §8/§10: chọn số ván khi tạo phòng + tour mới. */
export const TOUR_MIN = rules.tour.min;
export const TOUR_MAX = rules.tour.max;
export const TOUR_DEFAULT = rules.tour.defaultCount;
export const TOUR_PRESETS: readonly number[] = rules.tour.allowedCounts;
export const TOUR_RESULT_DISPLAY_MS = rules.tour.resultDisplayMs;

export interface TourCountCheck {
  /** `null` = chưa nhập (dùng mặc định) hoặc sai. */
  readonly value: number | null;
  readonly error: string | null;
}

const PLAIN_INT = /^\d+$/;

export function tourCountHint(): string {
  return `${TOUR_MIN}–${TOUR_MAX} ván`;
}

/** Validate ô tự nhập số ván; rỗng = dùng mặc định (không lỗi). */
export function validateTourCountInput(raw: string): TourCountCheck {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { value: null, error: null };
  if (!PLAIN_INT.test(trimmed)) {
    return { value: null, error: `Số ván phải là số nguyên từ ${TOUR_MIN} đến ${TOUR_MAX}.` };
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < TOUR_MIN || value > TOUR_MAX) {
    return { value: null, error: `Số ván phải nằm trong khoảng ${TOUR_MIN}–${TOUR_MAX}.` };
  }
  return { value, error: null };
}

/** Giá trị gửi server: ô rỗng → mặc định 10. */
export function resolveTourCount(raw: string): number {
  return validateTourCountInput(raw).value ?? TOUR_DEFAULT;
}

export function isTourPreset(value: string): boolean {
  const trimmed = value.trim();
  return PLAIN_INT.test(trimmed) && TOUR_PRESETS.includes(Number(trimmed));
}

export const TOUR_PLACE_LABELS: Readonly<Record<TourRankPlace, string>> = {
  nhat: 'Nhất',
  nhi: 'Nhì',
  ba: 'Ba',
  bet: 'Bét',
};

export function tourPlaceLabel(place: TourRankPlace | null): string {
  return place === null ? '—' : TOUR_PLACE_LABELS[place];
}

/** Xếp tạm theo doc-4 §5.3 (điểm → số Nhất → thối+đền ít hơn → ghế nhỏ hơn). */
function compareTourScores(a: TourScoreView, b: TourScoreView): number {
  if (b.pointsTotal !== a.pointsTotal) return b.pointsTotal - a.pointsTotal;
  if (b.wins !== a.wins) return b.wins - a.wins;
  const paidA = a.thoiTra + a.denTra;
  const paidB = b.thoiTra + b.denTra;
  if (paidA !== paidB) return paidA - paidB;
  return a.seat - b.seat;
}

export interface TourResultRowView {
  readonly seat: number;
  readonly nickname: string;
  readonly placeLabel: string;
  readonly roundPoints: number;
  readonly pointsTotal: number;
  readonly netChat: number;
  readonly isYou: boolean;
  readonly left: boolean;
  readonly joinedMid: boolean;
}

export interface TourResultOverlayView {
  /** `Ván 3/10`. */
  readonly roundLabel: string;
  readonly rows: readonly TourResultRowView[];
  readonly remainingMs: number;
  /** `Ván mới sau 9s` / `Đang chia ván mới…`. */
  readonly countdownLabel: string;
  /** `An đi trước ván tới`; null khi hết tour. */
  readonly nextLeaderLabel: string | null;
  readonly firstMoveFree: boolean;
  readonly isLastRound: boolean;
  readonly youRow: TourResultRowView | null;
}

export interface TourClockOptions {
  readonly serverNow: number;
  readonly receivedAt: number;
  readonly now: number;
}

export function tourCountdownMs(
  nextRoundAt: number | null,
  options: TourClockOptions,
): number {
  if (nextRoundAt === null) return 0;
  return computeRemainingMs(nextRoundAt, options.serverNow, options.receivedAt, options.now);
}

export function buildTourResultOverlay(
  result: TourResultView,
  youSeat: number,
  options: TourClockOptions,
): TourResultOverlayView {
  const rows = [...result.scores]
    .sort(compareTourScores)
    .map<TourResultRowView>((score) => ({
      seat: score.seat,
      nickname: score.nickname,
      placeLabel: tourPlaceLabel(score.lastPlace),
      roundPoints: score.roundPoints,
      pointsTotal: score.pointsTotal,
      netChat: score.netChat,
      isYou: score.seat === youSeat,
      left: score.left,
      joinedMid: score.joinedMid,
    }));
  const isLastRound = result.nextRoundIndex === null;
  const remainingMs = isLastRound ? 0 : tourCountdownMs(result.nextRoundAt, options);
  const countdownLabel = isLastRound
    ? 'Đang tổng kết tour…'
    : remainingMs > 0
      ? `Ván mới sau ${Math.ceil(remainingMs / 1000)}s`
      : 'Đang chia ván mới…';

  return {
    roundLabel: `Ván ${result.roundIndex}/${result.soVan}`,
    rows,
    remainingMs,
    countdownLabel,
    nextLeaderLabel:
      result.nextFirstNickname === null ? null : `${result.nextFirstNickname} đi trước ván tới`,
    firstMoveFree: result.nextFirstMoveFree,
    isLastRound,
    youRow: rows.find((row) => row.seat === youSeat) ?? null,
  };
}

const MEDALS: readonly string[] = ['🏆', '🥈', '🥉'];

export interface TourSummaryRowView {
  readonly seat: number;
  readonly rank: number;
  readonly medal: string | null;
  readonly nickname: string;
  readonly pointsTotal: number;
  readonly wins: number;
  readonly netChat: number;
  readonly thoiTra: number;
  readonly denTra: number;
  readonly paidTotal: number;
  readonly roundsPlayed: number;
  readonly joinedMid: boolean;
  readonly left: boolean;
  readonly isYou: boolean;
}

export interface TourSummaryView {
  readonly rows: readonly TourSummaryRowView[];
  readonly soVan: number;
  readonly roundsPlayed: number;
  readonly incomplete: boolean;
  /** `Kết thúc sớm (3/10 ván)` khi incomplete. */
  readonly earlyEndLabel: string | null;
  readonly youRow: TourSummaryRowView | null;
}

export function buildTourSummary(summary: TourEndView, youSeat: number): TourSummaryView {
  const rows = [...summary.rows]
    .sort((a, b) => a.tourRank - b.tourRank || a.seat - b.seat)
    .map<TourSummaryRowView>((row) => ({
      seat: row.seat,
      rank: row.tourRank,
      medal: MEDALS[row.tourRank - 1] ?? null,
      nickname: row.nickname,
      pointsTotal: row.pointsTotal,
      wins: row.wins,
      netChat: row.netChat,
      thoiTra: row.thoiTra,
      denTra: row.denTra,
      paidTotal: row.thoiTra + row.denTra,
      roundsPlayed: row.roundsPlayed,
      joinedMid: row.joinedMid,
      left: row.left,
      isYou: row.seat === youSeat,
    }));

  return {
    rows,
    soVan: summary.soVan,
    roundsPlayed: summary.roundsPlayed,
    incomplete: summary.incomplete,
    earlyEndLabel: summary.incomplete
      ? `Kết thúc sớm (${summary.roundsPlayed}/${summary.soVan} ván)`
      : null,
    youRow: rows.find((row) => row.seat === youSeat) ?? null,
  };
}

export function buildTourPausedMessage(paused: TourPausedView, maxSeats: number): string {
  const seats = Math.max(maxSeats, paused.present);
  return `Chờ thêm người (${paused.present}/${seats}) — cần ít nhất ${paused.needed}`;
}

export function buildDenBaiNotice(
  event: DenBaiView,
  names: ReadonlyMap<number, string>,
): string {
  const who = names.get(event.who) ?? `Ghế ${event.who + 1}`;
  const to = names.get(event.to) ?? `Ghế ${event.to + 1}`;
  return `${who} đền 13 lá cho ${to} (−${event.points} điểm)`;
}

export interface RoundBannerView {
  readonly roundLabel: string;
  readonly firstLabel: string | null;
  readonly firstMoveFree: boolean;
}

/** Chip `Ván i/N` + ai đi trước + lượt đầu tự do (doc-4 §4.2). */
export function buildRoundBanner(
  input: {
    readonly roundIndex: number | null | undefined;
    readonly soVan: number | null | undefined;
    readonly firstNickname: string | null;
    readonly firstMoveFree: boolean;
  },
): RoundBannerView | null {
  if (input.roundIndex === null || input.roundIndex === undefined) return null;
  const roundLabel =
    input.soVan === null || input.soVan === undefined
      ? `Ván ${input.roundIndex}`
      : `Ván ${input.roundIndex}/${input.soVan}`;
  return {
    roundLabel,
    firstLabel: input.firstNickname === null ? null : `${input.firstNickname} đi trước`,
    firstMoveFree: input.firstMoveFree,
  };
}

/** Overlay KET_QUA_VAN còn hợp lệ cho ván hiện tại hay đã sang ván mới. */
export function isTourResultStale(
  result: TourResultView | null,
  stateRoundIndex: number | null | undefined,
): boolean {
  if (result === null) return false;
  if (stateRoundIndex === null || stateRoundIndex === undefined) return false;
  return stateRoundIndex !== result.roundIndex;
}

export function tourPhaseLabel(tour: TourView | undefined): string | null {
  if (tour === undefined) return null;
  switch (tour.phase) {
    case 'running':
      return `Ván ${tour.roundIndex}/${tour.soVan}`;
    case 'betweenRounds':
      return `Ván ${tour.roundIndex}/${tour.soVan} · xem điểm`;
    case 'paused':
      return `Tạm dừng · ${tour.roundIndex}/${tour.soVan}`;
    case 'finished':
      return `Tổng kết ${tour.soVan} ván`;
    default:
      return null;
  }
}
