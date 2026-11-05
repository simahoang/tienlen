import { rules } from '../data';
import type { ConnectionStatus } from '../net/client';
import type {
  CardView,
  DenBaiView,
  TourEndView,
  TourPausedView,
  TourPhase,
  TourResultView,
} from '../net/protocol';
import { activateDialog } from '../ui/dom';
import { formatConnectionStatus } from '../ui/errors';
import { buildResultRows, formatPlace, formatPoints, type BreakdownEntry } from '../ui/result';
import { sortCards } from '../ui/table-logic';
import { formatCountdown } from '../ui/timer';
import { buildRoundBanner, isTourResultStale } from '../ui/tour';
import type { TableSeatView, TableViewModel } from '../ui/view-model';
import {
  renderDenBannerFor,
  renderTourPausedOverlay,
  renderTourResultOverlay,
  renderTourSummaryOverlay,
} from './tour-overlay';

export interface ChopView {
  readonly cards: readonly CardView[];
  readonly label: string;
  readonly remainingMs: number;
  readonly sent: boolean;
}

export interface TableTourRenderState {
  readonly result: TourResultView | null;
  readonly paused: TourPausedView | null;
  readonly end: TourEndView | null;
  /** Lần đền 13 lá gần nhất (chỉ hiện khi ghế tương ứng còn `denOut` trong ván). */
  readonly denBai: DenBaiView | null;
  readonly maxSeats: number;
  readonly isHost: boolean;
  /** Pha tour hiện tại từ `room.tour`; null = phòng không có tour. */
  readonly phase: TourPhase | null;
  /** Mốc server của state gần nhất, dùng cho đếm ngược `nextRoundAt`. */
  readonly serverNow: number;
  readonly receivedAt: number;
}

export interface TableActions {
  toggleCard(cardId: string): void;
  play(): void;
  pass(): void;
  surrender(): void;
  chop(): void;
  toggleMute(): void;
  leaveRoom(): void;
  leaveTour(): void;
  endTour(): void;
  newTour(soVan: number): void;
}

export interface TableRenderState {
  readonly view: TableViewModel;
  readonly status: ConnectionStatus;
  readonly reconnectAttempt: number;
  readonly selectedIds: ReadonlySet<string>;
  readonly hand: readonly CardView[];
  readonly playable: boolean;
  readonly playHint: string;
  readonly canPass: boolean;
  readonly canSurrender: boolean;
  readonly muted: boolean;
  readonly chop: ChopView | null;
  readonly breakdown: readonly BreakdownEntry[] | null;
  readonly tour: TableTourRenderState;
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

function suitSymbol(card: CardView): string {
  return rules.deck.suitSymbols[card.suit];
}

function isRed(card: CardView): boolean {
  return card.suit === 'hearts' || card.suit === 'diamonds';
}

function tableCard(card: CardView): HTMLElement {
  const node = element('span', `card-mini${isRed(card) ? ' card-mini--red' : ''}`);
  node.setAttribute('aria-label', `${card.rank} ${suitSymbol(card)}`);
  node.append(
    text('span', rules.deck.rankLabels[card.rank], 'card-mini__rank'),
    text('span', suitSymbol(card), 'card-mini__suit'),
  );
  return node;
}

function handCard(card: CardView, selected: boolean, actions: TableActions): HTMLButtonElement {
  const button = element('button', `hand-card${selected ? ' hand-card--selected' : ''}`);
  button.type = 'button';
  button.dataset['testid'] = `card-${card.id}`;
  button.setAttribute('aria-pressed', String(selected));
  button.setAttribute('aria-label', `${card.rank} ${suitSymbol(card)}`);
  const red = isRed(card) ? ' hand-card--red' : '';
  button.append(
    text('span', rules.deck.rankLabels[card.rank], `hand-card__rank${red}`),
    text('span', suitSymbol(card), `hand-card__suit${red}`),
  );
  button.addEventListener('click', () => {
    actions.toggleCard(card.id);
  });
  return button;
}

function seatRow(seat: TableSeatView): HTMLLIElement {
  const row = element('li', 'table-seat');
  row.dataset['testid'] = `turn-seat-${seat.seat}`;
  if (seat.nickname === null) row.classList.add('table-seat--empty');
  if (seat.isYou) row.classList.add('table-seat--you');
  if (seat.placed) {
    row.classList.add('table-seat--placed');
    row.dataset['placed'] = 'true';
  }
  if (seat.denOut) {
    row.classList.add('table-seat--den');
    row.dataset['denOut'] = 'true';
  }
  if (seat.place !== null) row.dataset['place'] = seat.place;
  if (seat.isTurn) {
    row.classList.add('table-seat--turn');
    row.setAttribute('aria-current', 'true');
  }
  if (seat.surrendered) row.classList.add('table-seat--out');

  row.append(text('span', seat.label, 'table-seat__label'));
  if (seat.denOut) {
    const denCards = text('span', '—', 'table-seat__cards');
    denCards.dataset['testid'] = `cards-left-${seat.seat}`;
    row.append(denCards);
  } else {
    const cards = text('span', `${seat.cardsLeft} lá`, 'table-seat__cards');
    cards.dataset['testid'] = `cards-left-${seat.seat}`;
    row.append(cards);
  }

  if (seat.nickname === null) {
    row.append(text('span', 'Trống', 'table-seat__empty'));
    return row;
  }

  row.append(text('span', seat.nickname, 'table-seat__name'));
  const badges = element('span', 'table-seat__badges');
  if (seat.isTurn) badges.append(text('span', 'Lượt', 'badge badge--turn'));
  if (seat.denOut) {
    const denBadge = text('span', 'Đã đền · rời ván', 'badge badge--den');
    denBadge.dataset['testid'] = `seat-den-${seat.seat}`;
    badges.append(denBadge);
    if (seat.denPoints > 0) {
      const denPoints = text('span', `−${seat.denPoints} điểm`, 'badge badge--den-points');
      denPoints.dataset['testid'] = `seat-den-points-${seat.seat}`;
      badges.append(denPoints);
    }
  } else if (seat.place !== null) {
    const placeBadge = text('span', formatPlace(seat.place), 'badge badge--place');
    placeBadge.dataset['testid'] = `seat-place-${seat.seat}`;
    placeBadge.dataset['place'] = seat.place;
    badges.append(placeBadge);
  } else if (seat.placed || seat.surrendered) {
    const outBadge = text('span', 'Đã rời', 'badge badge--off');
    outBadge.dataset['testid'] = `seat-place-${seat.seat}`;
    badges.append(outBadge);
  }
  if (seat.isYou) badges.append(text('span', 'Bạn', 'badge'));
  if (!seat.connected) badges.append(text('span', 'Mất kết nối', 'badge badge--off'));
  row.append(badges);
  return row;
}

/** Người đã chốt hạng nhưng ván còn chơi tiếp: không còn nút hành động, chỉ chờ. */
function placedNotice(view: TableViewModel): HTMLElement {
  const panel = element('section', 'waiting');
  panel.dataset['testid'] = 'placed-notice';
  panel.setAttribute('role', 'status');
  panel.setAttribute('aria-live', 'polite');
  const title = view.youDenOut
    ? 'Bạn đã đền 13 lá, rời ván này'
    : view.youPlace !== null
      ? `Bạn đã về ${formatPlace(view.youPlace)}`
      : 'Bạn đã rời ván';
  panel.append(
    text('p', title, 'waiting__title'),
    text('p', 'Chờ ván kết thúc…', 'waiting__hint'),
  );
  return panel;
}

function connectionBanner(status: ConnectionStatus, attempt: number): HTMLElement | null {
  const label = formatConnectionStatus(status);
  if (label === null) return null;
  const node = text('div', label, `connection connection--${status}`);
  node.setAttribute('role', 'status');
  if (status === 'reconnecting') {
    node.dataset['testid'] = 'reconnect-banner';
    node.textContent =
      attempt > 0 ? `Mất kết nối, đang thử lại… (lần ${attempt})` : 'Đang nối lại phiên cũ…';
  }
  return node;
}

function chopPanel(chop: ChopView, actions: TableActions): HTMLElement {
  const panel = element('div', 'chop-panel');
  const button = text('button', `Chặt (${chop.label})`, 'btn btn--chop');
  button.type = 'button';
  button.dataset['testid'] = 'chop';
  button.disabled = chop.sent;
  button.addEventListener('click', () => {
    actions.chop();
  });
  const timer = text('span', formatCountdown(chop.remainingMs), 'chop-timer');
  timer.dataset['testid'] = 'chop-timer';
  timer.dataset['level'] = 'warn';
  const hint = text(
    'span',
    chop.sent ? 'Đã gửi, chờ server…' : 'Cơ hội chặt ngoài lượt',
    'chop-panel__hint',
  );
  panel.append(button, timer, hint);
  return panel;
}

function resultOverlay(state: TableRenderState, actions: TableActions): HTMLElement | null {
  const { view } = state;
  if (!view.isFinished || view.ranking === null || view.ranking.length === 0) return null;
  const names = new Map<number, string>();
  for (const seat of view.seats) {
    if (seat.nickname !== null) names.set(seat.seat, seat.nickname);
  }
  const rows = buildResultRows(view.ranking, view.scores ?? [], names, state.breakdown);

  const overlay = element('div', 'result-overlay');
  overlay.dataset['testid'] = 'result-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'result-title');
  overlay.tabIndex = -1;
  const card = element('div', 'result-overlay__card');
  const title = text('h2', 'Kết quả ván', 'result__title');
  title.id = 'result-title';
  card.append(title);

  const list = element('ul', 'result__list');
  for (const row of rows) {
    const rowNode = element('li', 'result__row');
    rowNode.append(
      text('span', row.place, 'result__place'),
      text('span', row.nickname, 'result__name'),
      text('span', `${row.cardsLeft} lá`, 'result__cards'),
    );
    const total = text('span', `${row.total} điểm`, 'result__score');
    total.dataset['testid'] = `result-total-${row.seat}`;
    rowNode.append(total);
    if (row.lines.length > 0) {
      const lines = element('ul', 'result__lines');
      for (const line of row.lines) {
        lines.append(text('li', `${line.label}: ${formatPoints(line.points)}`, 'result__line'));
      }
      rowNode.append(lines);
    }
    list.append(rowNode);
  }

  const actionsRow = element('div', 'result-overlay__actions');
  const leave = text('button', 'Về sảnh', 'btn btn--primary');
  leave.type = 'button';
  leave.dataset['testid'] = 'leave-room';
  leave.addEventListener('click', () => {
    actions.leaveRoom();
  });
  actionsRow.append(leave);

  card.append(list, actionsRow);
  overlay.append(card);
  return overlay;
}

export function renderTable(
  mount: HTMLElement,
  state: TableRenderState,
  actions: TableActions,
): void {
  const { view } = state;
  const online = state.status === 'open';
  const screen = element('section', 'screen screen--table');

  const head = element('header', 'table-head');
  const headInfo = element('div');
  const code = text('h1', view.roomCode, 'room-code room-code--small');
  code.dataset['testid'] = 'room-code-label';
  headInfo.append(text('p', 'Phòng', 'eyebrow'), code);

  const headRight = element('div', 'table-head__right');
  const phase = text('span', view.phaseLabel, 'pill');
  phase.dataset['testid'] = 'phase';
  headRight.append(phase);
  if (view.tourLabel !== null) {
    const tourChip = text('span', view.tourLabel, 'pill pill--tour');
    tourChip.dataset['testid'] = 'tour-round-chip';
    headRight.append(tourChip);
  }
  const mute = text('button', state.muted ? 'Bật tiếng' : 'Tắt tiếng', 'btn btn--tiny');
  mute.type = 'button';
  mute.dataset['testid'] = 'mute';
  mute.setAttribute('aria-pressed', String(state.muted));
  mute.addEventListener('click', () => {
    actions.toggleMute();
  });
  headRight.append(mute);
  head.append(headInfo, headRight);

  const connection = connectionBanner(state.status, state.reconnectAttempt);
  if (connection !== null) screen.append(connection);

  const names = new Map<number, string>();
  for (const seat of view.seats) {
    if (seat.nickname !== null) names.set(seat.seat, seat.nickname);
  }

  const seats = element('ul', 'table-seats');
  seats.setAttribute('aria-label', 'Người chơi');
  for (const seat of view.seats) seats.append(seatRow(seat));

  const board = element('section', 'board');
  board.dataset['testid'] = 'table';
  board.setAttribute('aria-label', 'Bàn bài');

  const boardTop = element('div', 'board__top');
  const turn = text(
    'p',
    view.turnLabel,
    `board__turn${view.turnSeat === view.youSeat ? ' board__turn--you' : ''}`,
  );
  const timer = text('div', '—', 'timer');
  timer.dataset['testid'] = 'timer';
  timer.dataset['level'] = 'done';
  timer.setAttribute('aria-label', 'Thời gian còn lại');
  const live = text('span', '', 'sr-only');
  live.dataset['testid'] = 'timer-live';
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  boardTop.append(turn, timer, live);
  board.append(boardTop);

  const roundBanner =
    view.phase === 'playing' && view.tableCards.length === 0
      ? buildRoundBanner({
          roundIndex: view.roundIndex,
          soVan: view.soVan,
          firstNickname: view.firstPlayerNickname,
          firstMoveFree: view.firstMoveFree,
        })
      : null;
  if (roundBanner !== null && (roundBanner.firstLabel !== null || roundBanner.firstMoveFree)) {
    const banner = element('div', 'round-banner');
    banner.dataset['testid'] = 'round-banner';
    banner.setAttribute('role', 'status');
    banner.append(text('span', roundBanner.roundLabel, 'round-banner__round'));
    if (roundBanner.firstLabel !== null) {
      const first = text('span', roundBanner.firstLabel, 'round-banner__first');
      first.dataset['testid'] = 'first-player';
      banner.append(first);
    }
    if (roundBanner.firstMoveFree) {
      const free = text('span', 'Lượt đầu tự do — không cần 3♠', 'round-banner__free');
      free.dataset['testid'] = 'first-move-free';
      banner.append(free);
    }
    board.append(banner);
  }

  if (view.tableCards.length > 0) {
    const cards = element('div', 'board__cards');
    for (const card of view.tableCards) cards.append(tableCard(card));
    board.append(cards);
    if (view.lastPlayLabel !== null) {
      board.append(text('p', view.lastPlayLabel, 'board__last'));
    }
  } else {
    board.append(text('p', 'Chưa có nước đánh.', 'board__placeholder'));
  }

  screen.append(head, seats);

  const denEvent = state.tour.denBai;
  if (denEvent !== null && view.seats.some((seat) => seat.denOut)) {
    screen.append(renderDenBannerFor(denEvent, names));
  }

  screen.append(board);

  if ((view.youPlaced || view.youDenOut) && !view.isFinished) screen.append(placedNotice(view));

  if (state.chop !== null && !view.youPlaced && !view.youDenOut) {
    screen.append(chopPanel(state.chop, actions));
  }

  const tourResult = isTourResultStale(state.tour.result, view.roundIndex)
    ? null
    : state.tour.result;
  let tourOverlay: HTMLElement | null = null;
  if (state.tour.end !== null) {
    tourOverlay = renderTourSummaryOverlay({
      summary: state.tour.end,
      youSeat: view.youSeat,
      actions,
    });
  } else if (
    state.tour.paused !== null &&
    (state.tour.phase === null || state.tour.phase === 'paused')
  ) {
    tourOverlay = renderTourPausedOverlay({
      paused: state.tour.paused,
      maxSeats: state.tour.maxSeats,
      isHost: state.tour.isHost,
      actions,
    });
  } else if (tourResult !== null) {
    tourOverlay = renderTourResultOverlay({
      result: tourResult,
      youSeat: view.youSeat,
      serverNow: state.tour.serverNow,
      receivedAt: state.tour.receivedAt,
      now: Date.now(),
      isHost: state.tour.isHost,
      actions,
      breakdown: state.breakdown,
    });
  }

  const overlay = tourOverlay ?? resultOverlay(state, actions);
  if (overlay !== null) screen.append(overlay);

  if (!view.isFinished && !view.youPlaced && !view.youDenOut && tourOverlay === null) {
    const hand = element('section', 'hand');
    hand.dataset['testid'] = 'hand';
    hand.setAttribute('aria-label', 'Bài trên tay');
    const handHead = element('div', 'hand__head');
    handHead.append(
      text('span', `Bài của bạn (${view.handCount} lá)`, 'hand__title'),
      text('span', state.playHint, 'hand__hint'),
    );
    const cards = element('div', 'hand__cards');
    const sorted = sortCards(state.hand);
    for (const card of sorted) {
      cards.append(handCard(card, state.selectedIds.has(card.id), actions));
    }
    if (sorted.length === 0) cards.append(text('p', 'Không còn bài trên tay.', 'hint'));
    hand.append(handHead, cards);

    const actionBar = element('div', 'action-bar');
    const play = text('button', 'Đánh', 'btn btn--primary');
    play.type = 'button';
    play.dataset['testid'] = 'play';
    play.disabled = !state.playable || !online;
    play.addEventListener('click', () => {
      actions.play();
    });

    const pass = text('button', 'Bỏ lượt', 'btn');
    pass.type = 'button';
    pass.dataset['testid'] = 'pass';
    pass.disabled = !state.canPass || !online;
    pass.addEventListener('click', () => {
      actions.pass();
    });

    const surrender = text('button', 'Xin hàng', 'btn btn--danger');
    surrender.type = 'button';
    surrender.dataset['testid'] = 'surrender';
    surrender.disabled = !state.canSurrender || !online;
    surrender.addEventListener('click', () => {
      actions.surrender();
    });

    actionBar.append(play, pass, surrender);
    screen.append(hand, actionBar);
  }

  mount.replaceChildren(screen);
  const dialog = mount.querySelector<HTMLElement>('.result-overlay');
  if (dialog !== null) activateDialog(dialog);
}
