const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

export function readInput(root: ParentNode, selector: string): string {
  const element = root.querySelector<HTMLInputElement>(selector);
  return element ? element.value : '';
}

/** Focus phần tử đầu trong dialog và giữ Tab trong phạm vi overlay. */
export function activateDialog(overlay: HTMLElement, cardSelector = '.result-overlay__card'): void {
  const card = overlay.querySelector<HTMLElement>(cardSelector) ?? overlay;
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
