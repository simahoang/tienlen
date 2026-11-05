import type { ConnectionStatus } from '../net/client';
import { escapeHtml } from './dom';
import { formatConnectionStatus } from './errors';
import { TOUR_DEFAULT, TOUR_PRESETS, resolveTourCount, tourCountHint, validateTourCountInput } from './tour';
import type { LobbySeatView, LobbyView } from './view-model';

export interface LobbyFormState {
  readonly nickname: string;
  readonly code: string;
  /** Số ván/tour dạng chuỗi (ô tự nhập hoặc preset); rỗng = mặc định. */
  readonly tourCount: string;
}

export interface LobbyActions {
  createRoom(nickname: string, soVan?: number): void;
  joinRoom(code: string, nickname: string): void;
  setReady(ready: boolean): void;
  start(): void;
  retryConnection(): void;
  logout(): void;
  onNicknameChange(value: string): void;
  onCodeChange(value: string): void;
  onTourCountChange(value: string): void;
}

export interface LobbyRenderState {
  readonly view: LobbyView | null;
  readonly status: ConnectionStatus;
  readonly reconnectAttempt: number;
  readonly error: string | null;
  readonly form: LobbyFormState;
  /** Tên account hub; null = chưa xác thực xong (đang kiểm tra hoặc lỗi). */
  readonly authName: string | null;
  readonly canLogout: boolean;
  /** Thông báo trạng thái xác thực ("Đang kiểm tra đăng nhập…"). */
  readonly authNotice: string | null;
  /** Có URL hub khi phiên/kết nối chết và cần đăng nhập lại. */
  readonly reloginUrl: string | null;
  /** Nhãn nút relogin (vd: "Mở lại ở tab này" khi bị tab khác chiếm phiên). */
  readonly reloginLabel: string;
}

function connectionBanner(status: ConnectionStatus, attempt: number): string {
  const label = formatConnectionStatus(status);
  if (label === null) return '';
  if (status === 'reconnecting') {
    const message =
      attempt > 0 ? `Mất kết nối, đang thử lại… (lần ${attempt})` : 'Đang nối lại phiên cũ…';
    return `<div class="connection connection--${status}" data-testid="reconnect-banner" role="status">${escapeHtml(message)}</div>`;
  }
  return `<div class="connection connection--${status}" role="status">${escapeHtml(label)}</div>`;
}

function errorBlock(error: string | null): string {
  if (error === null) return '';
  return `<p class="msg msg--error" role="alert">${escapeHtml(error)}</p>`;
}

function noticeBlock(notice: string | null): string {
  if (notice === null) return '';
  return `<p class="hint" data-testid="auth-notice" role="status">${escapeHtml(notice)}</p>`;
}

function reloginBlock(state: LobbyRenderState): string {
  const url = state.reloginUrl;
  if (url === null || url.length === 0) return '';
  const label = state.reloginLabel.length > 0 ? state.reloginLabel : 'Đăng nhập lại';
  return `<a class="btn btn--ghost" data-testid="relogin" href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

function logoutButton(state: LobbyRenderState): string {
  if (!state.canLogout) return '';
  return `<button id="logout" class="btn btn--ghost" type="button"
    data-testid="logout">Đăng xuất</button>`;
}

function identityMarkup(state: LobbyRenderState): string {
  if (state.authName === null) return '';
  return `<div class="identity" data-testid="identity">
      <span class="identity__name">Chơi với tư cách <strong>${escapeHtml(state.authName)}</strong></span>
      ${logoutButton(state)}
    </div>`;
}

function seatMarkup(seat: LobbySeatView): string {
  if (seat.nickname === null) {
    return `<li class="seat seat--empty">
      <span class="seat__label">${seat.label}</span>
      <span class="seat__empty">Trống</span>
    </li>`;
  }
  const classes = ['seat'];
  if (seat.isYou) classes.push('seat--you');
  if (seat.ready) classes.push('seat--ready');
  return `<li class="${classes.join(' ')}">
    <span class="seat__label">${seat.label}</span>
    <span class="seat__name">${escapeHtml(seat.nickname)}</span>
    <span class="seat__badges">
      ${seat.isHost ? '<span class="badge badge--host">Chủ phòng</span>' : ''}
      ${seat.isYou ? '<span class="badge">Bạn</span>' : ''}
      ${seat.ready ? '<span class="badge badge--ready">Sẵn sàng</span>' : '<span class="badge badge--muted">Chưa sẵn sàng</span>'}
      ${seat.connected ? '' : '<span class="badge badge--off">Mất kết nối</span>'}
    </span>
  </li>`;
}

function nicknameField(state: LobbyRenderState): string {
  if (state.authName !== null) return '';
  return `<label class="field" for="nickname">
        <span class="field__label">Nickname</span>
        <input id="nickname" class="field__input" name="nickname" maxlength="20"
          data-testid="nickname" autocomplete="nickname" placeholder="Vd: An"
          value="${escapeHtml(state.form.nickname)}" />
      </label>`;
}

function tourCountField(state: LobbyRenderState): string {
  const raw = state.form.tourCount;
  const trimmed = raw.trim();
  const check = validateTourCountInput(raw);
  const presets = TOUR_PRESETS.map(
    (count) => `<button type="button" class="segmented__btn${
      trimmed === String(count) ? ' segmented__btn--active' : ''
    }" data-testid="tour-count-${count}" data-value="${count}"
      aria-pressed="${trimmed === String(count)}">${count}</button>`,
  ).join('');
  const errorText = check.error === null ? '' : escapeHtml(check.error);
  const error = `<p class="msg msg--error" data-testid="tour-count-error" role="alert"${
    errorText === '' ? ' hidden' : ''
  }>${errorText}</p>`;
  return `<fieldset class="tour-count" data-testid="tour-count">
      <legend class="field__label">Số ván mỗi tour</legend>
      <div class="segmented" role="group" aria-label="Chọn nhanh số ván">${presets}</div>
      <label class="field field--compact" for="tour-count-custom">
        <span class="sr-only">Hoặc tự nhập số ván</span>
        <input id="tour-count-custom" class="field__input" name="tourCount" maxlength="2"
          data-testid="tour-count-custom" inputmode="numeric" pattern="[0-9]*" autocomplete="off"
          placeholder="${TOUR_DEFAULT}" value="${escapeHtml(raw)}" />
      </label>
      <p class="hint tour-count__hint" data-testid="tour-count-hint">${escapeHtml(tourCountHint())}</p>
      ${error}
    </fieldset>`;
}

function entryMarkup(state: LobbyRenderState): string {
  const authed = state.authName !== null;
  const online = state.status === 'open';
  const tourError = validateTourCountInput(state.form.tourCount).error;
  const disabled = online && authed ? '' : ' disabled';
  const createDisabled = online && authed && tourError === null ? '' : ' disabled';
  const retry =
    state.status === 'closed' || (state.authName === null && state.authNotice === null)
      ? '<button id="retry" class="btn btn--ghost" type="button" data-testid="retry">Thử lại</button>'
      : '';
  return `<section class="screen screen--lobby">
    <header class="brand">
      <img class="brand__logo" src="/assets/card-back.svg" alt="" width="44" height="62" />
      <div>
        <h1 class="brand__title">Tiến Lên Miền Nam</h1>
        <p class="brand__tagline">Đánh bài online 2-4 người</p>
      </div>
    </header>
    ${connectionBanner(state.status, state.reconnectAttempt)}
    ${noticeBlock(state.authNotice)}
    ${identityMarkup(state)}
    <div class="panel">
      ${nicknameField(state)}
      ${tourCountField(state)}
      <button id="create-room" class="btn btn--primary" type="button"
        data-testid="create-room"${createDisabled}>Tạo phòng</button>
      <div class="divider"><span>hoặc vào phòng có sẵn</span></div>
      <label class="field" for="room-code">
        <span class="field__label">Mã phòng</span>
        <input id="room-code" class="field__input field__input--code" name="roomCode" maxlength="6"
          data-testid="room-code" inputmode="text" autocapitalize="characters" autocomplete="off"
          spellcheck="false" placeholder="ABCDE" value="${escapeHtml(state.form.code)}" />
      </label>
      <button id="join-room" class="btn" type="button" data-testid="join-room"${disabled}>Vào phòng</button>
      ${retry}
      ${reloginBlock(state)}
    </div>
    ${errorBlock(state.error)}
    <p class="hint">Chủ phòng tạo mã rồi gửi cho bạn bè. Cần 2-4 người để bắt đầu.</p>
  </section>`;
}

function roomMarkup(view: LobbyView, state: LobbyRenderState): string {
  const online = state.status === 'open';
  const disabled = online ? '' : ' disabled';
  const startButton = view.isHost
    ? `<button id="start" class="btn btn--primary" type="button" data-testid="start"${
        view.canStart && online ? '' : ' disabled'
      }>Bắt đầu</button>`
    : '';
  return `<section class="screen screen--room">
    <header class="room-head">
      <div>
        <p class="eyebrow">Phòng chờ</p>
        <h1 class="room-code" data-testid="room-code-label">${escapeHtml(view.roomCode)}</h1>
      </div>
      <span class="pill">${view.playerCount}/${view.maxSeats}</span>
    </header>
    ${connectionBanner(state.status, state.reconnectAttempt)}
    ${identityMarkup(state)}
    <ul class="seats" aria-label="Danh sách ghế">
      ${view.seats.map(seatMarkup).join('')}
    </ul>
    <div class="room-actions">
      <button id="ready" class="btn${view.selfReady ? ' btn--ghost' : ''}" type="button"
        data-testid="ready"${disabled}>
        ${view.selfReady ? 'Hủy sẵn sàng' : 'Sẵn sàng'}
      </button>
      ${startButton}
    </div>
    ${reloginBlock(state)}
    ${errorBlock(state.error)}
    <p class="hint">${
      view.isHost ? 'Bạn là chủ phòng.' : 'Chờ chủ phòng bắt đầu.'
    } Ván tự bắt đầu khi mọi người đều sẵn sàng.</p>
  </section>`;
}

function bind(mount: HTMLElement, state: LobbyRenderState, actions: LobbyActions): void {
  const nickname = mount.querySelector<HTMLInputElement>('#nickname');
  nickname?.addEventListener('input', () => {
    actions.onNicknameChange(nickname.value);
  });

  const code = mount.querySelector<HTMLInputElement>('#room-code');
  code?.addEventListener('input', () => {
    actions.onCodeChange(code.value);
  });

  const tourCount = mount.querySelector<HTMLInputElement>('#tour-count-custom');

  const syncTourCount = (value: string): void => {
    const errorText = validateTourCountInput(value).error;
    const errorEl = mount.querySelector<HTMLElement>('[data-testid="tour-count-error"]');
    if (errorEl !== null) {
      errorEl.textContent = errorText ?? '';
      errorEl.hidden = errorText === null;
    }
    const create = mount.querySelector<HTMLButtonElement>('#create-room');
    if (create !== null) {
      create.disabled = !(state.status === 'open' && state.authName !== null) || errorText !== null;
    }
    mount.querySelectorAll<HTMLButtonElement>('.segmented__btn').forEach((preset) => {
      const active = preset.dataset['value'] === value.trim();
      preset.classList.toggle('segmented__btn--active', active);
      preset.setAttribute('aria-pressed', String(active));
    });
    if (tourCount !== null && tourCount.value !== value) tourCount.value = value;
  };

  tourCount?.addEventListener('input', () => {
    actions.onTourCountChange(tourCount.value);
    syncTourCount(tourCount.value);
  });

  mount.querySelectorAll<HTMLButtonElement>('.segmented__btn').forEach((preset) => {
    preset.addEventListener('click', () => {
      const value = preset.dataset['value'] ?? '';
      syncTourCount(value);
      actions.onTourCountChange(value);
    });
  });

  mount.querySelector<HTMLButtonElement>('#create-room')?.addEventListener('click', () => {
    actions.createRoom(state.form.nickname, resolveTourCount(state.form.tourCount));
  });

  mount.querySelector<HTMLButtonElement>('#join-room')?.addEventListener('click', () => {
    actions.joinRoom(state.form.code, state.form.nickname);
  });

  mount.querySelector<HTMLButtonElement>('#retry')?.addEventListener('click', () => {
    actions.retryConnection();
  });

  mount.querySelector<HTMLButtonElement>('#logout')?.addEventListener('click', () => {
    actions.logout();
  });

  mount.querySelector<HTMLButtonElement>('#ready')?.addEventListener('click', () => {
    if (state.view) actions.setReady(!state.view.selfReady);
  });

  mount.querySelector<HTMLButtonElement>('#start')?.addEventListener('click', () => {
    actions.start();
  });
}

export function renderLobby(
  mount: HTMLElement,
  state: LobbyRenderState,
  actions: LobbyActions,
): void {
  mount.innerHTML = state.view ? roomMarkup(state.view, state) : entryMarkup(state);
  bind(mount, state, actions);
}
