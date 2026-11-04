const TOAST_DURATION_MS = 4000;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(message: string, durationMs = TOAST_DURATION_MS): void {
  let toast = document.querySelector<HTMLDivElement>('.toast');
  if (toast === null) {
    toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'alert');
    toast.setAttribute('aria-live', 'assertive');
    document.body.appendChild(toast);
  }
  toast.dataset['testid'] = 'toast';
  toast.textContent = message;
  toast.classList.add('toast--visible');

  if (hideTimer !== null) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    toast?.classList.remove('toast--visible');
  }, durationMs);
}
