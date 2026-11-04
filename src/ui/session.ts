export const SESSION_KEY = 'game2.session.v1';
export const SESSION_TTL_MS = 180_000;
const ROOM_CODE_PATTERN = /^[A-Z0-9]{4,6}$/;

export interface SavedSession {
  readonly roomCode: string;
  readonly token: string;
  readonly savedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseSavedSession(raw: string | null): SavedSession | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const roomCode = parsed['roomCode'];
  const token = parsed['token'];
  const savedAt = parsed['savedAt'];
  if (typeof roomCode !== 'string' || !ROOM_CODE_PATTERN.test(roomCode)) return null;
  if (typeof token !== 'string' || token.length < 16 || token.length > 128) return null;
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return null;
  return { roomCode, token, savedAt };
}

export function isSavedSessionValid(session: SavedSession, now: number): boolean {
  const age = now - session.savedAt;
  return age >= 0 && age <= SESSION_TTL_MS;
}

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function loadSavedSession(): SavedSession | null {
  const store = storage();
  if (store === null) return null;
  try {
    return parseSavedSession(store.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

export function saveSavedSession(session: SavedSession): void {
  try {
    storage()?.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Storage đầy/bị chặn: reconnect sau reload không khả dụng, game vẫn chạy.
  }
}

export function clearSavedSession(): void {
  try {
    storage()?.removeItem(SESSION_KEY);
  } catch {
    // Không cần xử lý thêm.
  }
}
