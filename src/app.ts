import { rules } from './data';
import { fetchAuthSession, logout, type AuthResult, type AuthSession } from './net/auth';
import { GameClient, resolveWsUrl } from './net/client';
import type { ClientSnapshot } from './net/client';
import { renderTable, type ChopView, type TableActions } from './scenes/table';
import { Ticker } from './ui/audio';
import { formatServerError } from './ui/errors';
import {
  defaultHandOrder,
  moveCardBy,
  moveCardTo,
  reconcileHandOrder,
} from './ui/hand-order';
import { renderLobby, type LobbyActions } from './ui/lobby';
import { parseBreakdown } from './ui/result';
import {
  clearSavedSession,
  isSavedSessionValid,
  loadSavedSession,
  saveSavedSession,
} from './ui/session';
import {
  canPassTurn,
  canSurrender,
  decideChop,
  evaluateSelection,
  findChopCandidate,
  resetChopAttempt,
  toggleSelection,
} from './ui/table-logic';
import { startChopCountdown, startTourCountdown, startTurnTimer } from './ui/timer';
import { showToast } from './ui/toast';
import { resolveTourCount, validateTourCountInput } from './ui/tour';
import {
  buildLobbyView,
  buildTableView,
  isSpectatorRoom,
  NICKNAME_MAX_LENGTH,
  normalizeNickname,
  normalizeRoomCode,
  resolveScreen,
  validateNickname,
  validateRoomCode,
} from './ui/view-model';

interface FormState {
  nickname: string;
  code: string;
  /** Ô số ván/tour dạng chuỗi; rỗng = dùng `rules.tour.defaultCount`. */
  tourCount: string;
}

const EXPIRED_CODES: ReadonlySet<string> = new Set([
  'INVALID_TOKEN',
  'RECONNECT_EXPIRED',
  'RECONNECT_WINDOW_EXPIRED',
  'SESSION_REPLACED',
]);

/** Lỗi khiến người chơi phải quay lại hub để đăng nhập. */
const RELOGIN_CODES: ReadonlySet<string> = new Set([
  'CLIENT_OFFLINE',
  'INVALID_TOKEN',
  'RECONNECT_EXPIRED',
  'RECONNECT_WINDOW_EXPIRED',
]);

/** Chờ danh sách phòng tối đa 3 giây rồi chuyển sang trạng thái lỗi + Thử lại. */
const ROOM_LIST_TIMEOUT_MS = 3_000;

export class App {
  readonly client: GameClient;
  private readonly root: HTMLElement;
  private readonly form: FormState = { nickname: '', code: '', tourCount: String(rules.tour.defaultCount) };
  private readonly ticker = new Ticker();
  private selected: Set<string> = new Set();
  /** Thứ tự bài thủ công (card id), giữ trong phiên; reset khi đổi phòng/thoát phòng. */
  private handOrder: string[] = [];
  private handRoomCode: string | null = null;
  private chopSentFor: string | null = null;
  private stopTimer: (() => void) | null = null;
  private stopChopTimer: (() => void) | null = null;
  private stopTourTimer: (() => void) | null = null;
  private localError: string | null = null;
  private lastErrorKey: string | null = null;
  private auth: AuthSession | null = null;
  private authName: string | null = null;
  private authNotice: string | null = 'Đang kiểm tra đăng nhập…';
  private hubLoginUrl: string | null = null;
  private authChecking = false;
  /** Tab khác đã chiếm phiên (close 4001) — giữ thông báo cho tới khi người chơi chủ động làm gì. */
  private sessionReplaced = false;
  /** Lỗi tải danh sách phòng ở sảnh; xoá khi server trả `roomList`. */
  private roomListError: string | null = null;
  private roomListTimer: ReturnType<typeof setTimeout> | null = null;
  private roomListWaitStartedAt: number | null = null;
  /** Nội dung đang soạn trong panel chat; giữ qua các lần render. */
  private chatDraft = '';
  /** Panel đang mở trên mobile (desktop luôn hiện cả hai). */
  private openPanel: 'leaderboard' | 'chat' | null = null;

  private readonly lobbyActions: LobbyActions = {
    createRoom: (nickname, soVan) => {
      const error = validateNickname(nickname);
      if (error !== null) {
        this.fail(error);
        return;
      }
      const tourCheck = validateTourCountInput(this.form.tourCount);
      if (tourCheck.error !== null) {
        this.fail(tourCheck.error);
        return;
      }
      const count = soVan ?? resolveTourCount(this.form.tourCount);
      if (count < rules.tour.min || count > rules.tour.max) {
        this.fail(`Số ván phải nằm trong khoảng ${rules.tour.min}–${rules.tour.max}.`);
        return;
      }
      this.localError = null;
      this.resetHandOrderState();
      this.client.createRoom(normalizeNickname(nickname), count);
    },
    joinRoom: (code, nickname) => {
      const nicknameError = validateNickname(nickname);
      if (nicknameError !== null) {
        this.fail(nicknameError);
        return;
      }
      const codeError = validateRoomCode(code);
      if (codeError !== null) {
        this.fail(codeError);
        return;
      }
      this.localError = null;
      this.resetHandOrderState();
      this.client.joinRoom(normalizeRoomCode(code), normalizeNickname(nickname));
    },
    setReady: (ready) => {
      this.localError = null;
      this.client.setReady(ready);
    },
    start: () => {
      this.localError = null;
      this.client.start();
    },
    retryConnection: () => {
      this.localError = null;
      this.lastErrorKey = null;
      this.sessionReplaced = false;
      this.client.clearError();
      if (this.auth === null) {
        void this.bootstrapAuth();
        return;
      }
      this.client.connect();
    },
    listRooms: () => {
      this.clearRoomListTimer();
      this.roomListWaitStartedAt = Date.now();
      this.roomListError = null;
      if (this.client.listRooms()) {
        this.startRoomListWait();
      } else {
        this.roomListWaitStartedAt = null;
        this.roomListError = 'Chưa tải được danh sách phòng. Kiểm tra kết nối rồi thử lại.';
      }
      this.render();
    },
    logout: () => {
      const hubLoginUrl = this.hubLoginUrl ?? this.auth?.hubLoginUrl ?? '';
      if (hubLoginUrl.length === 0) {
        this.fail('Không xác định được trang đăng nhập của hub.');
        return;
      }
      const csrf = this.auth?.csrf ?? '';
      this.sessionReplaced = false;
      this.stopTimer?.();
      this.stopTimer = null;
      this.stopChopTimer?.();
      this.stopChopTimer = null;
      this.stopTourTimer?.();
      this.stopTourTimer = null;
      this.selected.clear();
      this.chopSentFor = null;
      this.resetHandOrderState();
      clearSavedSession();
      this.client.close();
      void logout(hubLoginUrl, csrf);
    },
    onNicknameChange: (value) => {
      this.form.nickname = value;
      this.localError = null;
    },
    onCodeChange: (value) => {
      this.form.code = value;
      this.localError = null;
    },
    onTourCountChange: (value) => {
      this.form.tourCount = value;
      this.localError = null;
    },
  };

  private readonly tableActions: TableActions = {
    toggleCard: (cardId) => {
      this.selected = toggleSelection(this.selected, cardId);
      this.render();
    },
    reorderCard: (cardId, toIndex) => {
      this.handOrder = moveCardTo(this.ensureHandOrder(), cardId, toIndex);
      this.render();
      this.focusCard(cardId);
    },
    moveCardBy: (cardId, delta) => {
      this.handOrder = moveCardBy(this.ensureHandOrder(), cardId, delta);
      this.render();
      this.focusCard(cardId);
    },
    resetHandOrder: () => {
      this.handOrder = defaultHandOrder(this.client.getSnapshot().hand);
      this.render();
      this.root.querySelector<HTMLElement>('[data-testid="sort-reset"]')?.focus();
    },
    play: () => {
      const snapshot = this.client.getSnapshot();
      if (snapshot.room === null) return;
      const selection = evaluateSelection(
        snapshot.hand,
        this.selected,
        snapshot.state,
        snapshot.room.you.seat,
      );
      if (!selection.playable) return;
      this.client.play(selection.selected.map((card) => card.id));
    },
    pass: () => {
      this.client.pass();
    },
    surrender: () => {
      if (window.confirm('Bạn chắc chắn muốn xin hàng? Ván sẽ tính bạn thua.')) {
        this.client.surrender();
      }
    },
    chop: () => {
      const snapshot = this.client.getSnapshot();
      const window = snapshot.state?.chopWindow ?? null;
      if (window === null || snapshot.room === null) return;
      if (this.chopSentFor === window.targetActionId) return;
      const offer = findChopCandidate(
        snapshot.hand,
        window,
        snapshot.room.you.seat,
        snapshot.state?.trick.passed ?? [],
      );
      if (offer === null) return;
      this.chopSentFor = window.targetActionId;
      const sent = this.client.chop(
        offer.cards.map((card) => card.id),
        window.targetActionId,
      );
      if (!sent) this.chopSentFor = null;
      this.render();
    },
    toggleMute: () => {
      this.ticker.toggle();
      this.render();
    },
    leaveRoom: () => {
      this.stopTimer?.();
      this.stopTimer = null;
      this.stopChopTimer?.();
      this.stopChopTimer = null;
      this.stopTourTimer?.();
      this.stopTourTimer = null;
      clearSavedSession();
      this.selected.clear();
      this.chopSentFor = null;
      this.resetHandOrderState();
      this.localError = null;
      this.lastErrorKey = null;
      this.resetPanels();
      this.client.leaveRoom();
    },
    leaveWatch: () => {
      this.leaveWatchSession();
    },
    takeSeat: () => {
      const snapshot = this.client.getSnapshot();
      if (snapshot.room === null) return;
      this.selected.clear();
      this.chopSentFor = null;
      this.resetHandOrderState();
      this.localError = null;
      this.client.joinSeat(snapshot.room.code);
    },
    leaveTour: () => {
      const snapshot = this.client.getSnapshot();
      const room = snapshot.room;
      if (room !== null && (room.you.role === 'spectator' || room.you.seat === -1)) {
        // Khán giả không có tour để rời: nút "Rời tour" trong overlay coi như thoát xem.
        this.leaveWatchSession();
        return;
      }
      this.selected.clear();
      this.chopSentFor = null;
      this.resetPanels();
      this.client.leaveTour();
    },
    endTour: () => {
      this.client.endTour();
    },
    newTour: (soVan) => {
      this.selected.clear();
      this.chopSentFor = null;
      this.localError = null;
      const count = soVan >= rules.tour.min && soVan <= rules.tour.max
        ? soVan
        : resolveTourCount(this.form.tourCount);
      this.client.newTour(count);
    },
    sendChat: () => {
      const text = this.chatDraft.trim();
      if (text.length === 0) return;
      // Giữ draft khi gửi lỗi để người chơi không mất nội dung đã gõ.
      if (!this.client.sendChat(text)) return;
      this.chatDraft = '';
      this.render();
    },
    onChatDraftChange: (value) => {
      this.chatDraft = value;
      this.syncChatSendState();
    },
    togglePanel: (panel) => {
      this.openPanel = this.openPanel === panel ? null : panel;
      this.render();
    },
    closePanel: () => {
      if (this.openPanel === null) return;
      this.openPanel = null;
      this.render();
    },
  };

  constructor(root: HTMLElement, url: string = resolveWsUrl(import.meta.env.VITE_WS_URL)) {
    this.root = root;
    this.client = new GameClient({ url });
  }

  start(): void {
    this.client.subscribe(() => this.render());
    document.addEventListener('pointerdown', () => this.ticker.unlock(), { once: true });
    this.render();
    void this.bootstrapAuth();
  }

  /** Kiểm tra phiên hub trước khi mở WS: chưa đăng nhập thì về hub, lỗi thì cho thử lại. */
  private async bootstrapAuth(): Promise<void> {
    if (this.authChecking) return;
    this.authChecking = true;
    this.authNotice = 'Đang kiểm tra đăng nhập…';
    this.render();

    let result: AuthResult;
    try {
      result = await fetchAuthSession();
    } catch {
      result = 'error';
    }
    this.authChecking = false;

    if (result === 'error') {
      this.auth = null;
      this.authName = null;
      this.authNotice = null;
      this.fail('Không kiểm tra được phiên đăng nhập. Kiểm tra kết nối rồi bấm Thử lại.');
      return;
    }

    if ('kind' in result) {
      this.auth = null;
      this.authName = null;
      this.hubLoginUrl = result.hubLoginUrl.length > 0 ? result.hubLoginUrl : null;
      this.authNotice = 'Bạn chưa đăng nhập, đang chuyển về trang đăng nhập…';
      this.render();
      if (this.hubLoginUrl !== null) {
        window.location.assign(this.hubLoginUrl);
        return;
      }
      this.fail('Server không trả về trang đăng nhập. Bấm Thử lại.');
      return;
    }

    this.auth = result;
    this.authName = result.displayName;
    this.hubLoginUrl = result.hubLoginUrl;
    this.authNotice = null;
    this.localError = null;
    this.sessionReplaced = false;
    // Server tự lấy nickname từ phiên; giá trị này chỉ để API cũ/nhãn UI không trống.
    this.form.nickname = normalizeNickname(result.displayName).slice(0, NICKNAME_MAX_LENGTH);
    this.render();
    this.connectClient();
  }

  private connectClient(): void {
    const saved = loadSavedSession();
    if (saved !== null && isSavedSessionValid(saved, Date.now())) {
      this.client.resume(saved.token);
    } else {
      if (saved !== null) clearSavedSession();
      this.client.connect();
    }
  }

  private fail(message: string): void {
    this.localError = message;
    this.render();
  }

  /** Thứ tự đã đồng bộ với bài hiện tại (lá mới append theo mặc định). */
  private ensureHandOrder(): readonly string[] {
    this.handOrder = reconcileHandOrder(this.handOrder, this.client.getSnapshot().hand);
    return this.handOrder;
  }

  private focusCard(cardId: string): void {
    this.root.querySelector<HTMLElement>(`[data-testid="card-${cardId}"]`)?.focus();
  }

  private resetHandOrderState(): void {
    this.handOrder = [];
    this.handRoomCode = null;
  }

  /** Xoá trạng thái panel chat/BXH khi rời phòng hoặc rời tour. */
  private resetPanels(): void {
    this.chatDraft = '';
    this.openPanel = null;
  }

  /** Cập nhật nút Gửi ngay khi gõ (không render lại để không phá IME/focus). */
  private syncChatSendState(): void {
    const send = this.root.querySelector<HTMLButtonElement>('[data-testid="chat-send"]');
    if (send === null) return;
    const snapshot = this.client.getSnapshot();
    send.disabled =
      isSpectatorRoom(snapshot.room) ||
      snapshot.status !== 'open' ||
      this.chatDraft.trim().length === 0;
  }

  /** Thoát chế độ khán giả: xoá phiên local, giữ socket, xin lại danh sách phòng. */
  private leaveWatchSession(): void {
    this.selected.clear();
    this.chopSentFor = null;
    this.resetHandOrderState();
    clearSavedSession();
    this.localError = null;
    this.lastErrorKey = null;
    this.resetPanels();
    this.client.leaveWatch();
  }

  private clearRoomListTimer(): void {
    if (this.roomListTimer !== null) {
      clearTimeout(this.roomListTimer);
      this.roomListTimer = null;
    }
  }

  /** Một timer duy nhất cho mỗi lần chờ: render lại không tạo thêm timer. */
  private startRoomListWait(): void {
    if (this.roomListWaitStartedAt === null) this.roomListWaitStartedAt = Date.now();
    if (this.roomListTimer !== null) return;
    const elapsed = Date.now() - this.roomListWaitStartedAt;
    this.roomListTimer = setTimeout(() => {
      this.roomListTimer = null;
      this.roomListWaitStartedAt = null;
      const snapshot = this.client.getSnapshot();
      if (snapshot.roomList !== null || snapshot.room !== null) return;
      this.roomListError = 'Không tải được danh sách phòng. Kiểm tra kết nối rồi thử lại.';
      this.render();
    }, Math.max(0, ROOM_LIST_TIMEOUT_MS - elapsed));
  }

  /** Theo dõi danh sách phòng: bật/tắt timeout, không báo lỗi khi đang ở trong phòng. */
  private watchRoomList(snapshot: ClientSnapshot): void {
    if (snapshot.roomList !== null || snapshot.room !== null) {
      this.clearRoomListTimer();
      this.roomListWaitStartedAt = null;
      this.roomListError = null;
      return;
    }
    if (snapshot.status === 'closed') {
      this.clearRoomListTimer();
      this.roomListWaitStartedAt = null;
      this.roomListError = 'Mất kết nối tới server. Kiểm tra mạng rồi thử lại.';
      return;
    }
    if (snapshot.status !== 'open') {
      // Đang nối/nối lại: giữ skeleton, chưa tính timeout.
      this.clearRoomListTimer();
      this.roomListWaitStartedAt = null;
      return;
    }
    if (this.roomListError !== null) return;
    this.startRoomListWait();
  }

  private pruneSelection(hand: readonly { readonly id: string }[]): void {
    const handIds = new Set(hand.map((card) => card.id));
    for (const id of this.selected) {
      if (!handIds.has(id)) this.selected.delete(id);
    }
  }

  private reportServerError(code: string, message: string): void {
    const key = `${code}:${message}`;
    if (key === this.lastErrorKey) return;
    this.lastErrorKey = key;
    showToast(formatServerError(code, message));
    setTimeout(() => {
      this.client.clearError();
    }, 0);
  }

  private render(): void {
    const snapshot = this.client.getSnapshot();
    this.watchRoomList(snapshot);
    // Ở sảnh với socket mở thì phiên phòng cũ (kể cả khán giả) không còn giá trị.
    if (snapshot.room === null && snapshot.status === 'open') clearSavedSession();
    // Rời phòng/rời tour: bỏ draft + panel đang mở để sảnh sạch trạng thái.
    if (snapshot.room === null) this.resetPanels();
    if (snapshot.error === null) this.lastErrorKey = null;
    else {
      if (snapshot.error.code === 'SESSION_REPLACED') this.sessionReplaced = true;
      if (EXPIRED_CODES.has(snapshot.error.code)) clearSavedSession();
      // Lỗi chặt (WINDOW_CLOSED/LOST_RACE/ALREADY_PASSED/INVALID_BEAT...) phải mở khoá nút
      // để người chơi bấm lại nếu cửa sổ vẫn còn mở.
      this.chopSentFor = resetChopAttempt(this.chopSentFor, snapshot.error.code);
      this.reportServerError(snapshot.error.code, snapshot.error.message);
    }

    if (snapshot.room !== null) {
      // Vào phòng khác (kể cả resume) thì bỏ thứ tự cũ; cùng phòng thì giữ qua lượt/ván.
      if (this.handRoomCode !== snapshot.room.code) {
        this.handRoomCode = snapshot.room.code;
        this.handOrder = [];
      }
      this.handOrder = reconcileHandOrder(this.handOrder, snapshot.hand);
      saveSavedSession({
        roomCode: snapshot.room.code,
        token: snapshot.room.you.token,
        savedAt: Date.now(),
      });
    }

    this.stopTimer?.();
    this.stopTimer = null;
    this.stopChopTimer?.();
    this.stopChopTimer = null;
    this.stopTourTimer?.();
    this.stopTourTimer = null;

    const previousCards = this.root.querySelector<HTMLElement>('[data-testid="hand"] .hand__cards');
    const scrollLeft = previousCards ? previousCards.scrollLeft : 0;

    const screen = resolveScreen(snapshot.room);
    if (screen === 'table' && snapshot.room !== null) {
      this.pruneSelection(snapshot.hand);
      const selection = evaluateSelection(
        snapshot.hand,
        this.selected,
        snapshot.state,
        snapshot.room.you.seat,
      );
      const state = snapshot.state;
      const window = state?.chopWindow ?? null;
      if (window === null) this.chopSentFor = null;
      const sent = window !== null && this.chopSentFor === window.targetActionId;
      const decision = decideChop(
        window,
        snapshot.hand,
        state?.serverNow ?? Date.now(),
        snapshot.stateReceivedAt,
        Date.now(),
        snapshot.room.you.seat,
        state?.trick.passed ?? [],
      );
      const chop: ChopView | null =
        decision.visible && decision.offer !== null
          ? {
              cards: decision.offer.cards,
              label: decision.offer.label,
              remainingMs: decision.remainingMs,
              sent,
            }
          : null;
      const rawBreakdown = (state as unknown as Record<string, unknown> | null)?.['breakdown'];
      const tourServerNow = state?.serverNow ?? Date.now();
      const tourReceivedAt = state !== null ? snapshot.stateReceivedAt : Date.now();

      renderTable(
        this.root,
        {
          view: buildTableView(snapshot.room, state, snapshot.hand),
          status: snapshot.status,
          reconnectAttempt: snapshot.reconnectAttempt,
          selectedIds: this.selected,
          hand: snapshot.hand,
          handOrder: this.handOrder,
          playable: selection.playable,
          playHint: selection.hint,
          canPass: canPassTurn(state, snapshot.room.you.seat),
          canSurrender: canSurrender(state, snapshot.room.you.seat),
          muted: this.ticker.isMuted(),
          chop,
          breakdown: parseBreakdown(rawBreakdown),
          chatMessages: snapshot.chatMessages,
          chatDraft: this.chatDraft,
          openPanel: this.openPanel,
          tour: {
            result: snapshot.tourResult,
            paused: snapshot.tourPaused,
            end: snapshot.tourEnd,
            denBai: snapshot.lastDenBai,
            maxSeats: snapshot.room.maxSeats,
            isHost: snapshot.room.hostSeat === snapshot.room.you.seat,
            phase: snapshot.room.tour?.phase ?? null,
            serverNow: tourServerNow,
            receivedAt: tourReceivedAt,
          },
        },
        this.tableActions,
      );

      const tourResultSnapshot = snapshot.tourResult;
      if (tourResultSnapshot !== null && tourResultSnapshot.nextRoundAt !== null) {
        const tourCountdown = this.root.querySelector<HTMLElement>(
          '[data-testid="tour-countdown"]',
        );
        if (tourCountdown !== null) {
          this.stopTourTimer = startTourCountdown(tourCountdown, {
            nextRoundAt: tourResultSnapshot.nextRoundAt,
            serverNow: tourServerNow,
          });
        }
      }

      const nextCards = this.root.querySelector<HTMLElement>('[data-testid="hand"] .hand__cards');
      if (nextCards) nextCards.scrollLeft = scrollLeft;

      const timer = this.root.querySelector<HTMLElement>('[data-testid="timer"]');
      if (timer !== null) {
        const live = this.root.querySelector<HTMLElement>('[data-testid="timer-live"]');
        this.stopTimer = startTurnTimer(timer, {
          deadline: state?.turnDeadline ?? null,
          serverNow: state?.serverNow ?? Date.now(),
          warnMs: rules.turn.countdownWarnMs,
          onTick: () => this.ticker.tick(),
          ...(live !== null ? { liveElement: live } : {}),
        });
      }

      const chopTimer = this.root.querySelector<HTMLElement>('[data-testid="chop-timer"]');
      if (chopTimer !== null && window !== null && state !== null) {
        this.stopChopTimer = startChopCountdown(chopTimer, {
          closesAt: window.closesAt,
          serverNow: state.serverNow,
          onExpire: () => this.render(),
        });
      }
      return;
    }

    const needsRelogin =
      snapshot.status === 'closed' ||
      (snapshot.error !== null && RELOGIN_CODES.has(snapshot.error.code));
    const replacedNotice = this.sessionReplaced
      ? formatServerError('SESSION_REPLACED', 'Tài khoản đã được mở ở tab khác')
      : null;
    const offlineNotice =
      needsRelogin && this.authName !== null && replacedNotice === null
        ? 'Phiên đăng nhập hoặc kết nối đã hết. Hãy đăng nhập lại.'
        : null;
    const showRelogin = this.sessionReplaced || needsRelogin;

    renderLobby(
      this.root,
      {
        view: snapshot.room === null ? null : buildLobbyView(snapshot.room),
        status: snapshot.status,
        reconnectAttempt: snapshot.reconnectAttempt,
        error: this.localError ?? replacedNotice ?? offlineNotice,
        form: this.form,
        authName: this.authName,
        canLogout: this.auth !== null,
        authNotice: this.authNotice,
        reloginUrl: showRelogin ? this.hubLoginUrl : null,
        reloginLabel: this.sessionReplaced ? 'Mở lại ở tab này' : 'Đăng nhập lại',
        roomList: snapshot.roomList,
        roomListError: this.roomListError,
      },
      this.lobbyActions,
    );
  }
}
