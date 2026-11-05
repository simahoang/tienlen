import { rules } from '../data';
import type { ConnectionStatus } from '../net/client';
import {
  CHAT_MAX,
  type CardView,
  type ChatMessageView,
  type DenBaiView,
  type TourEndView,
  type TourPausedView,
  type TourPhase,
  type TourResultView,
} from '../net/protocol';
import { activateDialog } from '../ui/dom';
import { formatConnectionStatus } from '../ui/errors';
import { orderedHand } from '../ui/hand-order';
import { buildResultRows, formatPlace, formatPoints, type BreakdownEntry } from '../ui/result';
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
  /** Thả lá vào vị trí `toIndex` trong danh sách đã bỏ lá đang kéo. */
  reorderCard(cardId: string, toIndex: number): void;
  /** Dịch lá ±1 vị trí (bàn phím Alt+←/→). */
  moveCardBy(cardId: string, delta: number): void;
  resetHandOrder(): void;
  play(): void;
  pass(): void;
  surrender(): void;
  chop(): void;
  toggleMute(): void;
  leaveRoom(): void;
  /** Khán giả thoát xem, giữ kết nối và về sảnh. */
  leaveWatch(): void;
  /** Khán giả xin vào ghế trống (phòng lobby còn chỗ). */
  takeSeat(): void;
  leaveTour(): void;
  endTour(): void;
  newTour(soVan: number): void;
  /** Gửi nội dung chat đang soạn (đã trim; rỗng thì bỏ qua). */
  sendChat(): void;
  onChatDraftChange(value: string): void;
  /** Mobile: mở/đóng panel trái hoặc phải; chỉ một panel mở cùng lúc. */
  togglePanel(panel: 'leaderboard' | 'chat'): void;
  closePanel(): void;
}

export type SidePanelKind = 'leaderboard' | 'chat';

export interface TableRenderState {
  readonly view: TableViewModel;
  readonly status: ConnectionStatus;
  readonly reconnectAttempt: number;
  readonly selectedIds: ReadonlySet<string>;
  readonly hand: readonly CardView[];
  /** Thứ tự thủ công (card id) do người chơi tự sắp; rỗng = thứ tự mặc định. */
  readonly handOrder: readonly string[];
  readonly playable: boolean;
  readonly playHint: string;
  readonly canPass: boolean;
  readonly canSurrender: boolean;
  readonly muted: boolean;
  readonly chop: ChopView | null;
  readonly breakdown: readonly BreakdownEntry[] | null;
  readonly tour: TableTourRenderState;
  /** Lịch sử + tin chat live của phòng. */
  readonly chatMessages: readonly ChatMessageView[];
  /** Nội dung đang soạn trong ô chat (giữ qua các lần render). */
  readonly chatDraft: string;
  /** Panel đang mở trên mobile; null = đóng cả hai. Desktop luôn hiện cả hai. */
  readonly openPanel: SidePanelKind | null;
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

function tableCard(card: CardView, testid?: string): HTMLElement {
  const node = element('span', `card-mini${isRed(card) ? ' card-mini--red' : ''}`);
  node.setAttribute('aria-label', `${card.rank} ${suitSymbol(card)}`);
  if (testid !== undefined) node.dataset['testid'] = testid;
  node.append(
    text('span', rules.deck.rankLabels[card.rank], 'card-mini__rank'),
    text('span', suitSymbol(card), 'card-mini__suit'),
  );
  return node;
}

/** Ngưỡng di chuyển (px) để phân biệt chạm chọn bài và kéo sắp xếp. */
const DRAG_THRESHOLD = 8;

/** Vị trí chèn trong danh sách đã bỏ lá đang kéo, tính theo tâm lá dưới con trỏ. */
function dropIndexFor(button: HTMLButtonElement, clientX: number): number {
  const cards = button.parentElement?.querySelectorAll<HTMLElement>('.hand-card');
  if (cards === undefined) return 0;
  let index = 0;
  for (const node of cards) {
    if (node === button) continue;
    const rect = node.getBoundingClientRect();
    if (clientX > rect.left + rect.width / 2) index += 1;
  }
  return index;
}

/** Cuộn ngang khi kéo tới sát mép để với tới lá ngoài màn hình. */
function autoScrollCards(button: HTMLButtonElement, clientX: number): void {
  const container = button.closest<HTMLElement>('.hand__cards');
  if (container === null) return;
  const rect = container.getBoundingClientRect();
  const edge = 36;
  if (clientX < rect.left + edge) container.scrollLeft -= 10;
  else if (clientX > rect.right - edge) container.scrollLeft += 10;
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

  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let dragging = false;
  let clickGuardUntil = 0;

  const endDrag = (): void => {
    dragging = false;
    button.classList.remove('hand-card--dragging');
    button.style.transform = '';
    document.body.classList.remove('is-dragging-card');
  };

  button.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    dragging = false;
  });

  button.addEventListener('pointermove', (event) => {
    if (pointerId !== event.pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      // Vuốt dọc chiếm ưu thế: nhường cho trình duyệt cuộn trang.
      if (Math.abs(dy) > Math.abs(dx)) {
        pointerId = null;
        return;
      }
      dragging = true;
      button.setPointerCapture(event.pointerId);
      button.classList.add('hand-card--dragging');
      document.body.classList.add('is-dragging-card');
    }
    event.preventDefault();
    const lift = selected ? -18 : -6;
    button.style.transform = `translate(${dx}px, ${lift}px) scale(1.04)`;
    autoScrollCards(button, event.clientX);
  });

  button.addEventListener('pointerup', (event) => {
    if (pointerId !== event.pointerId) return;
    pointerId = null;
    if (!dragging) return;
    const toIndex = dropIndexFor(button, event.clientX);
    // Click vẫn bắn sau pointerup: chặn để không toggle selection sau khi thả.
    clickGuardUntil = performance.now() + 250;
    endDrag();
    actions.reorderCard(card.id, toIndex);
  });

  button.addEventListener('pointercancel', () => {
    pointerId = null;
    if (dragging) endDrag();
  });

  button.addEventListener('click', (event) => {
    if (performance.now() < clickGuardUntil) {
      event.preventDefault();
      return;
    }
    actions.toggleCard(card.id);
  });

  // Alt+←/→ (hoặc Shift+←/→ khi trình duyệt chiếm Alt) đổi chỗ lá đang focus.
  button.addEventListener('keydown', (event) => {
    if (!event.altKey && !event.shiftKey) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    actions.moveCardBy(card.id, event.key === 'ArrowLeft' ? -1 : 1);
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
  const leave = text('button', view.isSpectator ? 'Thoát xem' : 'Về sảnh', 'btn btn--primary');
  leave.type = 'button';
  leave.dataset['testid'] = view.isSpectator ? 'leave-watch' : 'leave-room';
  leave.addEventListener('click', () => {
    if (view.isSpectator) actions.leaveWatch();
    else actions.leaveRoom();
  });
  actionsRow.append(leave);

  card.append(list, actionsRow);
  overlay.append(card);
  return overlay;
}

/** Nút đóng panel trên mobile (desktop ẩn). */
function panelCloseButton(testId: string, label: string, actions: TableActions): HTMLButtonElement {
  const close = text('button', 'Đóng', 'btn btn--tiny side-panel__close');
  close.type = 'button';
  close.dataset['testid'] = testId;
  close.setAttribute('aria-label', label);
  close.addEventListener('click', () => {
    actions.closePanel();
  });
  return close;
}

function panelShell(
  kind: SidePanelKind,
  title: string,
  open: boolean,
  actions: TableActions,
): { panel: HTMLElement; body: HTMLElement } {
  const panel = element(
    'aside',
    `side-panel side-panel--${kind}${open ? ' side-panel--open' : ''}`,
  );
  panel.id = `${kind}-panel`;
  panel.dataset['testid'] = kind === 'chat' ? 'chat-panel' : 'leaderboard-panel';
  panel.setAttribute('aria-label', title);

  const head = element('div', 'side-panel__head');
  head.append(text('h2', title, 'side-panel__title'));
  head.append(
    panelCloseButton(
      kind === 'chat' ? 'close-chat' : 'close-leaderboard',
      `Đóng ${title.toLowerCase()}`,
      actions,
    ),
  );
  const body = element('div', 'side-panel__body');
  panel.append(head, body);
  return { panel, body };
}

function leaderboardRow(
  seat: number,
  rank: number,
  nickname: string,
  meta: string,
  isYou: boolean,
  left: boolean,
  points: number | null,
): HTMLLIElement {
  const row = element(
    'li',
    `lb-row${isYou ? ' lb-row--you' : ''}${left ? ' lb-row--left' : ''}`,
  );
  row.dataset['testid'] = `leaderboard-row-${seat}`;
  row.dataset['rank'] = String(rank);
  if (left) row.dataset['left'] = 'true';
  if (isYou) row.dataset['you'] = 'true';

  const rankNode = text('span', `#${rank}`, 'lb-row__rank');
  const main = element('div', 'lb-row__main');
  const nameRow = element('span', 'lb-row__name-row');
  nameRow.append(text('span', isYou ? `${nickname} (bạn)` : nickname, 'lb-row__name'));
  if (left) nameRow.append(text('span', 'Đã rời', 'badge badge--off lb-row__left'));
  const metaNode = text('span', meta, 'lb-row__meta');
  main.append(nameRow, metaNode);
  row.append(rankNode, main);
  if (points !== null) {
    const pointsNode = text('span', String(points), 'lb-row__points');
    pointsNode.dataset['testid'] = `leaderboard-points-${seat}`;
    row.append(pointsNode);
  }
  return row;
}

function leaderboardPanel(state: TableRenderState, actions: TableActions): HTMLElement {
  const { view } = state;
  const { panel, body } = panelShell(
    'leaderboard',
    'Bảng xếp hạng',
    state.openPanel === 'leaderboard',
    actions,
  );
  const list = element('ol', 'lb-list');
  const tourRows = view.leaderboard;
  if (tourRows.length > 0) {
    tourRows.forEach((row, index) => {
      list.append(
        leaderboardRow(
          row.seat,
          index + 1,
          row.nickname,
          `${row.wins} thắng · ${row.roundsPlayed} ván`,
          row.seat === view.youSeat && !view.isSpectator,
          row.left,
          row.pointsTotal,
        ),
      );
    });
  } else {
    // Phòng không mở tour: xếp tạm theo số lá còn lại (ít lá = gần về nhất).
    const fallback = view.seats
      .filter((seat) => seat.nickname !== null)
      .slice()
      .sort((a, b) => a.cardsLeft - b.cardsLeft || a.seat - b.seat);
    fallback.forEach((seat, index) => {
      list.append(
        leaderboardRow(
          seat.seat,
          index + 1,
          seat.nickname ?? '',
          `${seat.cardsLeft} lá`,
          seat.isYou,
          seat.surrendered,
          null,
        ),
      );
    });
    if (fallback.length === 0) {
      body.append(text('p', 'Chưa có người chơi.', 'side-panel__empty'));
      return panel;
    }
  }
  body.append(list);
  return panel;
}

function chatMessageItem(message: ChatMessageView, youSeat: number): HTMLLIElement {
  const mine = message.seat === youSeat && youSeat >= 0;
  const item = element('li', `chat-msg${mine ? ' chat-msg--you' : ''}`);
  item.dataset['testid'] = `chat-message-${message.id}`;
  item.dataset['seat'] = String(message.seat);
  const meta = element('div', 'chat-msg__meta');
  meta.append(text('span', message.nickname, 'chat-msg__name'));
  if (message.role === 'spectator') {
    const badge = text('span', 'Khán giả', 'badge badge--muted chat-msg__role');
    badge.dataset['testid'] = 'chat-role-spectator';
    meta.append(badge);
  }
  const time = new Date(message.at);
  const stamp = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
  meta.append(text('span', stamp, 'chat-msg__time'));
  item.append(meta, text('p', message.text, 'chat-msg__text'));
  return item;
}

function chatPanel(state: TableRenderState, actions: TableActions): HTMLElement {
  const { view } = state;
  const { panel, body } = panelShell('chat', 'Chat', state.openPanel === 'chat', actions);
  const online = state.status === 'open';

  const list = element('ul', 'chat-messages');
  list.dataset['testid'] = 'chat-messages';
  list.setAttribute('role', 'log');
  list.setAttribute('aria-live', 'polite');
  list.setAttribute('aria-label', 'Tin nhắn trong phòng');
  for (const message of state.chatMessages) {
    list.append(chatMessageItem(message, view.youSeat));
  }
  if (state.chatMessages.length === 0) {
    const empty = text('p', 'Chưa có tin nhắn nào.', 'chat-empty');
    empty.dataset['testid'] = 'chat-empty';
    list.append(empty);
  }
  body.append(list);

  if (view.isSpectator) {
    const hint = text('p', 'Khán giả chỉ xem chat', 'chat-readonly');
    hint.dataset['testid'] = 'chat-readonly';
    body.append(hint);
  }

  const compose = element('div', 'chat-compose');
  const input = element('textarea', 'chat-input');
  input.dataset['testid'] = 'chat-input';
  input.rows = 1;
  input.maxLength = CHAT_MAX;
  input.value = state.chatDraft;
  input.placeholder = view.isSpectator ? 'Khán giả chỉ xem chat' : 'Nhập tin nhắn…';
  input.disabled = view.isSpectator || !online;
  input.setAttribute('aria-label', 'Nội dung tin nhắn');
  input.addEventListener('input', () => {
    actions.onChatDraftChange(input.value);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    actions.sendChat();
  });

  const send = text('button', 'Gửi', 'btn btn--primary btn--tiny chat-send');
  send.type = 'button';
  send.dataset['testid'] = 'chat-send';
  send.disabled = view.isSpectator || !online || state.chatDraft.trim().length === 0;
  send.addEventListener('click', () => {
    actions.sendChat();
  });
  compose.append(input, send);
  body.append(compose);
  return panel;
}

export function renderTable(
  mount: HTMLElement,
  state: TableRenderState,
  actions: TableActions,
): void {
  const { view } = state;
  const online = state.status === 'open';
  // Render lại giữa lúc kéo sẽ thay DOM: gỡ trạng thái kéo còn sót.
  document.body.classList.remove('is-dragging-card');
  const screen = element('section', 'screen screen--table');

  const head = element('header', 'table-head');
  const headInfo = element('div');
  const code = text('h1', view.roomCode, 'room-code room-code--small');
  code.dataset['testid'] = 'room-code-label';
  headInfo.append(text('p', 'Phòng', 'eyebrow'), code);

  const headRight = element('div', 'table-head__right');

  // Toggle panel chỉ hiện trên mobile (CSS ẩn ở desktop >=1100px).
  const toggles = element('div', 'table-head__toggles');
  const lbToggle = text('button', 'BXH', 'btn btn--tiny panel-toggle');
  lbToggle.type = 'button';
  lbToggle.dataset['testid'] = 'toggle-leaderboard';
  lbToggle.setAttribute('aria-expanded', String(state.openPanel === 'leaderboard'));
  lbToggle.setAttribute('aria-controls', 'leaderboard-panel');
  lbToggle.setAttribute('aria-label', 'Bảng xếp hạng');
  lbToggle.addEventListener('click', () => {
    actions.togglePanel('leaderboard');
  });
  const chatToggle = text('button', 'Chat', 'btn btn--tiny panel-toggle');
  chatToggle.type = 'button';
  chatToggle.dataset['testid'] = 'toggle-chat';
  chatToggle.setAttribute('aria-expanded', String(state.openPanel === 'chat'));
  chatToggle.setAttribute('aria-controls', 'chat-panel');
  chatToggle.setAttribute('aria-label', 'Chat phòng');
  chatToggle.addEventListener('click', () => {
    actions.togglePanel('chat');
  });
  toggles.append(lbToggle, chatToggle);
  headRight.append(toggles);

  const phase = text('span', view.phaseLabel, 'pill');
  phase.dataset['testid'] = 'phase';
  headRight.append(phase);
  if (view.tourLabel !== null) {
    const tourChip = text('span', view.tourLabel, 'pill pill--tour');
    tourChip.dataset['testid'] = 'tour-round-chip';
    headRight.append(tourChip);
  }
  if (view.isSpectator || view.spectatorCount > 0) {
    const spectators = text('span', `${view.spectatorCount} khán giả`, 'pill pill--spectators');
    spectators.dataset['testid'] = 'spectator-count';
    spectators.setAttribute('aria-label', `${view.spectatorCount} khán giả đang xem`);
    headRight.append(spectators);
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
  screen.append(head);

  const connection = connectionBanner(state.status, state.reconnectAttempt);
  if (connection !== null) screen.append(connection);

  if (view.isSpectator) {
    const banner = element('section', 'spectator-banner');
    banner.dataset['testid'] = 'spectator-banner';
    banner.setAttribute('role', 'status');
    banner.append(
      text('p', 'Đang xem với tư cách khán giả', 'spectator-banner__text'),
      text('p', 'Bạn không có bài và không thể đánh trong ván này.', 'spectator-banner__hint'),
    );
    const bannerActions = element('div', 'spectator-banner__actions');
    if (view.canTakeSeat) {
      const seat = text('button', 'Vào ghế', 'btn btn--primary');
      seat.type = 'button';
      seat.dataset['testid'] = 'take-seat';
      seat.disabled = !online;
      seat.addEventListener('click', () => {
        actions.takeSeat();
      });
      bannerActions.append(seat);
    }
    const leaveWatch = text('button', 'Thoát xem', 'btn btn--ghost');
    leaveWatch.type = 'button';
    leaveWatch.dataset['testid'] = 'leave-watch';
    leaveWatch.disabled = !online;
    leaveWatch.addEventListener('click', () => {
      actions.leaveWatch();
    });
    bannerActions.append(leaveWatch);
    banner.append(bannerActions);
    screen.append(banner);
  }

  // 3 cột desktop: BXH | bàn bài | chat. Mobile: 1 cột + drawer (xem styles.css).
  const layout = element('div', 'table-layout');
  const main = element('div', 'table-main');
  layout.append(leaderboardPanel(state, actions), main, chatPanel(state, actions));
  screen.append(layout);

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
    const table = element('div', 'board__table');
    // Lớp mờ của bộ đánh ngay trước (chỉ 1 tầng, không nhận click, không đọc lại bằng screen reader).
    if (view.previousTableCards.length > 0) {
      const previous = element('div', 'board__previous');
      previous.dataset['testid'] = 'previous-table';
      previous.setAttribute(
        'aria-label',
        `Nước trước: ${view.previousTableLabel ?? `${view.previousTableComboSize} lá`}`,
      );
      const previousCards = element('div', 'board__previous-cards');
      previousCards.setAttribute('aria-hidden', 'true');
      for (const card of view.previousTableCards) {
        previousCards.append(tableCard(card, `previous-card-${card.id}`));
      }
      previous.append(previousCards);
      const previousLabel = text(
        'p',
        `Nước trước: ${view.previousTableLabel ?? `${view.previousTableComboSize} lá`}`,
        'board__previous-label',
      );
      previousLabel.dataset['testid'] = 'previous-play-label';
      previousLabel.setAttribute('aria-hidden', 'true');
      previous.append(previousLabel);
      table.append(previous);
    }
    const cards = element('div', 'board__cards');
    for (const card of view.tableCards) cards.append(tableCard(card));
    table.append(cards);
    if (view.lastPlayLabel !== null) {
      table.append(text('p', view.lastPlayLabel, 'board__last'));
    }
    board.append(table);
  } else {
    board.append(text('p', 'Chưa có nước đánh.', 'board__placeholder'));
  }

  main.append(seats);

  const denEvent = state.tour.denBai;
  if (denEvent !== null && view.seats.some((seat) => seat.denOut)) {
    main.append(renderDenBannerFor(denEvent, names));
  }

  main.append(board);

  if ((view.youPlaced || view.youDenOut) && !view.isFinished && !view.isSpectator) {
    main.append(placedNotice(view));
  }

  if (state.chop !== null && !view.youPlaced && !view.youDenOut && !view.isSpectator) {
    main.append(chopPanel(state.chop, actions));
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

  if (
    !view.isFinished &&
    !view.youPlaced &&
    !view.youDenOut &&
    !view.isSpectator &&
    tourOverlay === null
  ) {
    const hand = element('section', 'hand');
    hand.dataset['testid'] = 'hand';
    hand.setAttribute('aria-label', 'Bài trên tay');
    const handHead = element('div', 'hand__head');
    const handMeta = element('div', 'hand__meta');
    handMeta.append(text('span', state.playHint, 'hand__hint'));
    const resetOrder = text('button', 'Xếp lại', 'btn btn--tiny hand__reset');
    resetOrder.type = 'button';
    resetOrder.dataset['testid'] = 'sort-reset';
    resetOrder.title = 'Sắp bài theo thứ tự mặc định';
    resetOrder.setAttribute('aria-label', 'Sắp lại bài theo thứ tự mặc định');
    resetOrder.disabled = !online;
    resetOrder.addEventListener('click', () => {
      actions.resetHandOrder();
    });
    handMeta.append(resetOrder);
    handHead.append(
      text('span', `Bài của bạn (${view.handCount} lá)`, 'hand__title'),
      handMeta,
    );
    const cards = element('div', 'hand__cards');
    const ordered = orderedHand(state.hand, state.handOrder);
    for (const card of ordered) {
      cards.append(handCard(card, state.selectedIds.has(card.id), actions));
    }
    if (ordered.length === 0) cards.append(text('p', 'Không còn bài trên tay.', 'hint'));
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
    main.append(hand, actionBar);
  }

  // Render lại thay toàn bộ DOM: giữ focus + vị trí con trỏ trong ô chat.
  const active = document.activeElement;
  const chatInputTestId =
    active instanceof HTMLElement ? active.dataset['testid'] : undefined;
  const hadChatFocus = chatInputTestId === 'chat-input';
  const caret = hadChatFocus ? (active as HTMLTextAreaElement).selectionStart : null;

  mount.replaceChildren(screen);

  if (hadChatFocus) {
    const input = mount.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]');
    if (input !== null && !input.disabled) {
      input.focus();
      if (caret !== null) input.setSelectionRange(caret, caret);
    }
  }

  // Chat luôn cuộn xuống tin mới nhất.
  const messages = mount.querySelector<HTMLElement>('[data-testid="chat-messages"]');
  if (messages !== null) messages.scrollTop = messages.scrollHeight;

  const dialog = mount.querySelector<HTMLElement>('.result-overlay');
  if (dialog !== null) activateDialog(dialog);
}
