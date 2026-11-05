import type { DenBaiView, TourEndView, TourPausedView, TourResultView } from '../net/protocol';
import { activateDialog } from '../ui/dom';
import { buildBreakdownItems, formatPoints, type BreakdownEntry } from '../ui/result';
import {
  buildDenBaiNotice,
  buildTourPausedMessage,
  buildTourResultOverlay,
  buildTourSummary,
} from '../ui/tour';

export interface TourOverlayActions {
  leaveTour(): void;
  endTour(): void;
  newTour(soVan: number): void;
  leaveRoom(): void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  return node;
}

function text<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  value: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = element(tag, className);
  node.textContent = value;
  return node;
}

function dialog(testId: string, titleId: string, extraClass?: string): {
  overlay: HTMLElement;
  card: HTMLElement;
} {
  const overlay = element('div', `result-overlay${extraClass ? ` ${extraClass}` : ''}`);
  overlay.dataset['testid'] = testId;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', titleId);
  overlay.tabIndex = -1;
  const card = element('div', 'result-overlay__card');
  overlay.append(card);
  return { overlay, card };
}

function button(
  label: string,
  testId: string,
  variant: string,
  onClick: () => void,
): HTMLButtonElement {
  const node = text('button', label, `btn${variant.length > 0 ? ` ${variant}` : ''}`);
  node.type = 'button';
  node.dataset['testid'] = testId;
  node.addEventListener('click', onClick);
  return node;
}

function roundTableRows(
  rows: ReturnType<typeof buildTourResultOverlay>['rows'],
  breakdown: readonly BreakdownEntry[] | null,
): HTMLElement {
  const list = element('ul', 'tour-round-rows');
  for (const row of rows) {
    const item = element('li', `tour-round-row${row.isYou ? ' tour-round-row--you' : ''}`);
    item.dataset['testid'] = `tour-round-row-${row.seat}`;
    item.append(
      text('span', row.placeLabel, 'tour-round-row__place'),
      text(
        'span',
        `${row.nickname}${row.isYou ? ' (bạn)' : ''}${row.left ? ' · đã rời' : ''}`,
        'tour-round-row__name',
      ),
      text('span', formatPoints(row.roundPoints), 'tour-round-row__round'),
      text('span', `${row.pointsTotal}`, 'tour-round-row__total'),
      text(
        'span',
        row.netChat === 0 ? '' : `chặt ${formatPoints(row.netChat)}`,
        'tour-round-row__meta',
      ),
    );
    const lines = buildBreakdownItems(breakdown, row.seat);
    if (lines.length > 0) {
      const lineList = element('ul', 'tour-round-row__lines');
      for (const line of lines) {
        lineList.append(text('li', `${line.label}: ${formatPoints(line.points)}`, ''));
      }
      item.append(lineList);
    }
    list.append(item);
  }
  return list;
}

export function renderTourResultOverlay(params: {
  readonly result: TourResultView;
  readonly youSeat: number;
  readonly serverNow: number;
  readonly receivedAt: number;
  readonly now: number;
  readonly isHost: boolean;
  readonly actions: TourOverlayActions;
  readonly breakdown: readonly BreakdownEntry[] | null;
}): HTMLElement {
  const data = buildTourResultOverlay(params.result, params.youSeat, {
    serverNow: params.serverNow,
    receivedAt: params.receivedAt,
    now: params.now,
  });
  const { overlay, card } = dialog('tour-result-overlay', 'tour-result-title');
  const head = element('div', 'tour-overlay__head');
  const title = text('h2', 'Kết quả ván', 'result__title');
  title.id = 'tour-result-title';
  const progress = text('span', data.roundLabel, 'pill');
  progress.dataset['testid'] = 'tour-round-label';
  head.append(title, progress);

  const header = element('div', 'tour-round-header');
  header.append(
    text('span', 'Hạng', 'tour-round-header__place'),
    text('span', 'Người chơi', 'tour-round-header__name'),
    text('span', 'Ván này', 'tour-round-header__round'),
    text('span', 'Tổng tour', 'tour-round-header__total'),
  );

  const countdown = text('p', data.countdownLabel, 'tour-countdown');
  countdown.dataset['testid'] = 'tour-countdown';
  countdown.dataset['level'] = data.remainingMs > 0 ? 'warn' : 'done';
  countdown.setAttribute('role', 'status');
  countdown.setAttribute('aria-live', 'polite');

  card.append(head, header, roundTableRows(data.rows, params.breakdown), countdown);

  if (data.isLastRound) {
    card.append(text('p', 'Hết ván cuối, đang tổng kết tour…', 'hint'));
  } else {
    if (params.result.nextRoundIndex !== null) {
      const nextRound = text(
        'p',
        `Ván tiếp theo ${params.result.nextRoundIndex}/${params.result.soVan}`,
        'hint',
      );
      nextRound.dataset['testid'] = 'tour-next-round';
      card.append(nextRound);
    }
    if (data.nextLeaderLabel !== null) {
      const leader = text('p', data.nextLeaderLabel, 'tour-next-leader');
      leader.dataset['testid'] = 'tour-next-leader';
      card.append(leader);
    }
    if (data.firstMoveFree) {
      const free = text('p', 'Lượt đầu tự do — không cần đánh 3♠', 'tour-first-free');
      free.dataset['testid'] = 'tour-first-free';
      card.append(free);
    }
  }

  const actions = element('div', 'result-overlay__actions');
  actions.append(
    button('Rời tour', 'tour-leave', 'btn btn--ghost', () => params.actions.leaveTour()),
  );
  if (params.isHost) {
    actions.append(
      button('Kết thúc sớm', 'tour-end-early', 'btn btn--danger', () => {
        if (window.confirm('Kết thúc tour sớm? Bảng tổng kết sẽ ghi tour chưa đủ ván.')) {
          params.actions.endTour();
        }
      }),
    );
  }
  card.append(actions);

  return overlay;
}

export function renderTourPausedOverlay(params: {
  readonly paused: TourPausedView;
  readonly maxSeats: number;
  readonly isHost: boolean;
  readonly actions: TourOverlayActions;
}): HTMLElement {
  const { overlay, card } = dialog('tour-paused', 'tour-paused-title');
  const title = text('h2', 'Tạm dừng tour', 'result__title');
  title.id = 'tour-paused-title';
  const reason = text(
    'p',
    buildTourPausedMessage(params.paused, params.maxSeats),
    'tour-paused__reason',
  );
  reason.dataset['testid'] = 'tour-paused-reason';
  const hint = text('p', 'Ván mới tự chia khi đủ người, không cần bấm sẵn sàng.', 'hint');

  const actions = element('div', 'result-overlay__actions');
  actions.append(
    button('Rời tour', 'tour-leave', 'btn btn--ghost', () => params.actions.leaveTour()),
  );
  if (params.isHost) {
    actions.append(
      button('Kết thúc sớm', 'tour-end-early', 'btn btn--danger', () => {
        if (window.confirm('Kết thúc tour sớm? Bảng tổng kết sẽ ghi tour chưa đủ ván.')) {
          params.actions.endTour();
        }
      }),
    );
  }
  card.append(title, reason, hint, actions);
  return overlay;
}

export function renderTourSummaryOverlay(params: {
  readonly summary: TourEndView;
  readonly youSeat: number;
  readonly actions: TourOverlayActions;
}): HTMLElement {
  const data = buildTourSummary(params.summary, params.youSeat);
  const { overlay, card } = dialog('tour-summary', 'tour-summary-title', 'tour-summary');
  const head = element('div', 'tour-overlay__head');
  const title = text('h2', 'Tổng kết tour', 'result__title');
  title.id = 'tour-summary-title';
  const count = text(
    'span',
    data.incomplete ? `${data.roundsPlayed}/${data.soVan} ván` : `${data.soVan} ván`,
    'pill',
  );
  head.append(title, count);
  card.append(head);
  if (data.earlyEndLabel !== null) {
    const early = text('p', data.earlyEndLabel, 'tour-summary__early');
    early.dataset['testid'] = 'tour-summary-incomplete';
    card.append(early);
  }

  const list = element('ul', 'tour-summary__rows');
  for (const row of data.rows) {
    const item = element('li', `tour-summary__row${row.isYou ? ' tour-summary__row--you' : ''}`);
    item.dataset['testid'] = `tour-summary-row-${row.seat}`;
    item.dataset['rank'] = String(row.rank);

    const headRow = element('div', 'tour-summary__row-head');
    headRow.append(
      text(
        'span',
        `${row.medal ?? `#${row.rank}`} ${row.nickname}${row.isYou ? ' (bạn)' : ''}`,
        'tour-summary__name',
      ),
      text('span', `${row.pointsTotal} điểm`, 'tour-summary__points'),
    );
    const rank = text('span', `Hạng ${row.rank}`, 'tour-summary__rank');
    rank.dataset['testid'] = `tour-summary-rank-${row.seat}`;
    const flag = text(
      'span',
      row.left ? 'Đã rời' : row.joinedMid ? 'Vào giữa tour' : `${row.roundsPlayed} ván`,
      `tour-summary__flag${row.left ? ' tour-summary__flag--left' : ''}`,
    );
    const details = element('dl', 'tour-summary__details');
    details.append(
      text('dt', 'Nhất', ''),
      text('dd', `${row.wins} ván`, ''),
      text('dt', 'Chặt (net)', ''),
      text('dd', formatPoints(row.netChat), ''),
      text('dt', 'Thối trả', ''),
      text('dd', `−${row.thoiTra}`, ''),
      text('dt', 'Đền trả', ''),
      text('dd', `−${row.denTra}`, ''),
    );
    headRow.append(rank, flag);
    item.append(headRow, details);
    list.append(item);
  }
  card.append(list);

  if (data.youRow !== null) {
    card.append(
      text(
        'p',
        `Bạn xếp hạng ${data.youRow.rank} với ${data.youRow.pointsTotal} điểm.`,
        'tour-summary__you',
      ),
    );
  }

  const actions = element('div', 'tour-summary__actions');
  actions.append(
    button('Về sảnh', 'tour-home', 'btn', () => params.actions.leaveRoom()),
    button('Tour mới cùng ghế', 'tour-new', 'btn btn--primary', () =>
      params.actions.newTour(data.soVan),
    ),
  );
  card.append(actions);
  return overlay;
}

export function renderDenBanner(notice: string): HTMLElement {
  const node = text('div', notice, 'den-banner');
  node.dataset['testid'] = 'den-banner';
  node.setAttribute('role', 'status');
  return node;
}

export function renderDenBannerFor(
  event: DenBaiView,
  names: ReadonlyMap<number, string>,
): HTMLElement {
  return renderDenBanner(buildDenBaiNotice(event, names));
}

export function attachDialogFocus(overlay: HTMLElement): void {
  activateDialog(overlay);
}
