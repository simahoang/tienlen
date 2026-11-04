import { rules } from '../data';
import type { ConnectionStatus } from '../net/client';
import type { CardView } from '../net/protocol';
import { formatConnectionStatus } from '../ui/errors';
import { buildResultRows, formatPoints, type BreakdownEntry } from '../ui/result';
import { sortCards } from '../ui/table-logic';
import { formatCountdown } from '../ui/timer';
import type { TableSeatView, TableViewModel } from '../ui/view-model';

export interface ChopView {
  readonly cards: readonly CardView[];
  readonly label: string;
  readonly remainingMs: number;
  readonly sent: boolean;
}

export interface TableActions {
  toggleCard(cardId: string): void;
  play(): void;
  pass(): void;
  surrender(): void;
  chop(): void;
  toggleMute(): void;
  leaveRoom(): void;
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
  if (seat.isTurn) {
    row.classList.add('table-seat--turn');
    row.setAttribute('aria-current', 'true');
  }
  if (seat.surrendered) row.classList.add('table-seat--out');

  row.append(text('span', seat.label, 'table-seat__label'));
  const cards = text('span', `${seat.cardsLeft} lá`, 'table-seat__cards');
  cards.dataset['testid'] = `cards-left-${seat.seat}`;
  row.append(cards);

  if (seat.nickname === null) {
    row.append(text('span', 'Trống', 'table-seat__empty'));
    return row;
  }

  row.append(text('span', seat.nickname, 'table-seat__name'));
  const badges = element('span', 'table-seat__badges');
  if (seat.isTurn) badges.append(text('span', 'Lượt', 'badge badge--turn'));
  if (seat.isYou) badges.append(text('span', 'Bạn', 'badge'));
  if (seat.surrendered) badges.append(text('span', 'Đã rời', 'badge badge--off'));
  if (!seat.connected) badges.append(text('span', 'Mất kết nối', 'badge badge--off'));
  row.append(badges);
  return row;
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

function activateDialog(overlay: HTMLElement): void {
  const card = overlay.querySelector<HTMLElement>('.result-overlay__card') ?? overlay;
  const focusables = (): HTMLElement[] =>
    Array.from(
      card.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
  const first = focusables()[0];
  if (first) first.focus({ preventScroll: true });
  else overlay.focus({ preventScroll: true });

  overlay.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const items = focusables();
    const firstItem = items[0];
    const lastItem = items[items.length - 1];
    if (!firstItem || !lastItem) {
      event.preventDefault();
      overlay.focus({ preventScroll: true });
      return;
    }
    if (event.shiftKey && document.activeElement === firstItem) {
      event.preventDefault();
      lastItem.focus({ preventScroll: true });
    } else if (!event.shiftKey && document.activeElement === lastItem) {
      event.preventDefault();
      firstItem.focus({ preventScroll: true });
    }
  });
}

function resultOverlay(state: TableRenderState, actions: TableActions): HTMLElement | null {
  const { view } = state;
  if (!view.isFinished || view.ranking === null) return null;
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
  const newGame = text('button', 'Ván mới', 'btn');
  newGame.type = 'button';
  newGame.disabled = true;
  newGame.title = 'Server chưa hỗ trợ ván mới';
  const leave = text('button', 'Về sảnh', 'btn btn--primary');
  leave.type = 'button';
  leave.dataset['testid'] = 'leave-room';
  leave.addEventListener('click', () => {
    actions.leaveRoom();
  });
  actionsRow.append(newGame, leave);

  card.append(list, actionsRow, text('p', 'Server chưa hỗ trợ ván mới.', 'hint'));
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
  const mute = text('button', state.muted ? 'Bật tiếng' : 'Tắt tiếng', 'btn btn--tiny');
  mute.type = 'button';
  mute.dataset['testid'] = 'mute';
  mute.setAttribute('aria-pressed', String(state.muted));
  mute.addEventListener('click', () => {
    actions.toggleMute();
  });
  headRight.append(phase, mute);
  head.append(headInfo, headRight);

  const connection = connectionBanner(state.status, state.reconnectAttempt);
  if (connection !== null) screen.append(connection);

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

  screen.append(head, seats, board);

  if (state.chop !== null) screen.append(chopPanel(state.chop, actions));

  const overlay = resultOverlay(state, actions);
  if (overlay !== null) screen.append(overlay);

  if (!view.isFinished) {
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
  const dialog = mount.querySelector<HTMLElement>('[data-testid="result-overlay"]');
  if (dialog !== null) activateDialog(dialog);
}
