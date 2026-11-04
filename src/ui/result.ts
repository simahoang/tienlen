import type { RankingView } from '../net/protocol';

export type ScoreEventType =
  | 'place'
  | 'toiTrang'
  | 'chop'
  | 'chatChong'
  | 'thoi'
  | 'denGiu13La';

export interface BreakdownEntry {
  readonly type: ScoreEventType;
  readonly from: number | null;
  readonly to: number | null;
  readonly points: number;
  readonly note: string | null;
}

export interface BreakdownItem {
  readonly label: string;
  readonly points: number;
}

export interface ResultRow {
  readonly seat: number;
  readonly nickname: string;
  readonly place: string;
  readonly cardsLeft: number;
  readonly total: number;
  readonly lines: readonly BreakdownItem[];
}

const PLACE_LABELS: Readonly<Record<RankingView['place'], string>> = {
  nhat: 'Nhất',
  nhi: 'Nhì',
  ba: 'Ba',
  bet: 'Bét',
};

const EVENT_LABELS: Readonly<Record<ScoreEventType, string>> = {
  place: 'Hạng',
  toiTrang: 'Tới trắng',
  chop: 'Chặt',
  chatChong: 'Chặt chồng',
  thoi: 'Thối',
  denGiu13La: 'Đền 13 lá',
};

const EVENT_TYPES: ReadonlySet<string> = new Set(Object.keys(EVENT_LABELS));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSeat(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0);
}

/** Parse `state.breakdown` server trả khi finished; bỏ entry lỗi, không throw. */
export function parseBreakdown(raw: unknown): readonly BreakdownEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const entries: BreakdownEntry[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const type = item['type'];
    const from = item['from'];
    const to = item['to'];
    const points = item['points'];
    const note = item['note'];
    if (typeof type !== 'string' || !EVENT_TYPES.has(type)) continue;
    if (!isSeat(from) || !isSeat(to)) continue;
    if (typeof points !== 'number' || !Number.isFinite(points)) continue;
    entries.push({
      type: type as ScoreEventType,
      from,
      to,
      points,
      note: typeof note === 'string' ? note : null,
    });
  }
  return entries.length > 0 ? entries : null;
}

export function formatPoints(points: number): string {
  return points > 0 ? `+${points}` : String(points);
}

export function buildResultRows(
  ranking: readonly RankingView[],
  scores: readonly number[],
  names: ReadonlyMap<number, string>,
  breakdown: readonly BreakdownEntry[] | null,
): readonly ResultRow[] {
  return ranking.map((entry) => {
    const lines: BreakdownItem[] = [];
    for (const item of breakdown ?? []) {
      const label = EVENT_LABELS[item.type];
      if (item.to === entry.seat) lines.push({ label, points: item.points });
      if (item.from === entry.seat && item.from !== item.to) {
        lines.push({ label, points: -item.points });
      }
    }
    const total = scores[entry.seat] ?? lines.reduce((sum, line) => sum + line.points, 0);
    return {
      seat: entry.seat,
      nickname: names.get(entry.seat) ?? `Ghế ${entry.seat + 1}`,
      place: PLACE_LABELS[entry.place],
      cardsLeft: entry.cardsLeft,
      total,
      lines,
    };
  });
}
