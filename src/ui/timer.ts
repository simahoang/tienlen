export type TimerLevel = 'normal' | 'warn' | 'done';

const ANNOUNCE_SECONDS: ReadonlySet<number> = new Set([10, 5, 3, 1]);

/** Chỉ announce ở các mốc 10/5/3/1 để aria-live không spam mỗi giây. */
export function shouldAnnounce(seconds: number): boolean {
  return ANNOUNCE_SECONDS.has(seconds);
}

/** Ước lượng server time theo offset giữa `serverNow` lúc nhận state và đồng hồ máy. */
export function computeRemainingMs(
  deadline: number | null,
  serverNow: number,
  receivedAt: number,
  now: number,
): number {
  if (deadline === null) return 0;
  return Math.max(0, deadline - (serverNow + (now - receivedAt)));
}

export function formatRemaining(ms: number): string {
  return `${Math.ceil(Math.max(0, ms) / 1000)}s`;
}

export function formatCountdown(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

export interface ChopCountdownOptions {
  readonly closesAt: number;
  readonly serverNow: number;
  readonly onExpire?: () => void;
}

export function startChopCountdown(
  element: HTMLElement,
  options: ChopCountdownOptions,
): () => void {
  const receivedAt = Date.now();
  let expired = false;

  const update = (): void => {
    const remaining = computeRemainingMs(options.closesAt, options.serverNow, receivedAt, Date.now());
    element.textContent = formatCountdown(remaining);
    element.dataset['level'] = remaining > 0 ? 'warn' : 'done';
    if (remaining <= 0 && !expired) {
      expired = true;
      // Trì hoãn để caller kịp gán hàm cleanup trước khi re-render.
      setTimeout(() => options.onExpire?.(), 0);
    }
  };

  update();
  const interval = setInterval(update, 100);
  return () => clearInterval(interval);
}

export function timerLevel(remainingMs: number, warnMs: number): TimerLevel {
  if (remainingMs <= 0) return 'done';
  if (remainingMs <= warnMs) return 'warn';
  return 'normal';
}

export interface TurnTimerOptions {
  readonly deadline: number | null;
  readonly serverNow: number;
  readonly warnMs: number;
  readonly onTick?: () => void;
  readonly liveElement?: HTMLElement;
}

export function startTurnTimer(element: HTMLElement, options: TurnTimerOptions): () => void {
  if (options.deadline === null) {
    element.textContent = '—';
    element.dataset['level'] = 'done';
    if (options.liveElement) options.liveElement.textContent = '';
    return () => undefined;
  }

  const receivedAt = Date.now();
  let lastSecond = -1;

  const update = (): void => {
    const remaining = computeRemainingMs(
      options.deadline,
      options.serverNow,
      receivedAt,
      Date.now(),
    );
    element.textContent = formatRemaining(remaining);
    const level = timerLevel(remaining, options.warnMs);
    element.dataset['level'] = level;

    const second = Math.ceil(remaining / 1000);
    if (second !== lastSecond) {
      lastSecond = second;
      if (level === 'warn' && remaining > 0) options.onTick?.();
      if (options.liveElement) {
        if (remaining <= 0) options.liveElement.textContent = 'Hết giờ';
        else if (shouldAnnounce(second)) {
          options.liveElement.textContent = `Còn ${second} giây`;
        }
      }
    }
  };

  update();
  const interval = setInterval(update, 200);
  return () => clearInterval(interval);
}
