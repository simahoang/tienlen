/**
 * Phiên đăng nhập do server Game2 giữ trong cookie `g2_session`.
 * Client chỉ đọc trạng thái qua HTTP cùng origin, không lưu token/secret.
 */

export interface AuthSession {
  readonly username: string;
  readonly displayName: string;
  readonly csrf: string;
  readonly hubLoginUrl: string;
}

export interface UnauthenticatedResult {
  readonly kind: 'unauthenticated';
  readonly hubLoginUrl: string;
}

export type AuthResult = AuthSession | UnauthenticatedResult | 'error';

const ME_URL = '/auth/me';
const LOGOUT_URL = '/auth/logout';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

async function readJsonBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await response.json();
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Đọc phiên hiện tại.
 * - 200: trả AuthSession đã kiểm kiểu.
 * - 401: trả `{ kind: 'unauthenticated', hubLoginUrl }` (URL lấy từ server, không hard-code).
 * - lỗi mạng/parse/thiếu field: trả 'error' để UI cho thử lại thay vì crash.
 */
export async function fetchAuthSession(): Promise<AuthResult> {
  let response: Response;
  try {
    response = await fetch(ME_URL, { credentials: 'same-origin', cache: 'no-store' });
  } catch {
    return 'error';
  }

  const body = await readJsonBody(response);

  if (response.status === 401) {
    const hubLoginUrl = body === null ? null : readString(body, 'hubLoginUrl');
    return { kind: 'unauthenticated', hubLoginUrl: hubLoginUrl ?? '' };
  }

  if (!response.ok || body === null) return 'error';

  const username = readString(body, 'username');
  const csrf = readString(body, 'csrf');
  const hubLoginUrl = readString(body, 'hubLoginUrl');
  if (username === null || username.length === 0 || csrf === null || hubLoginUrl === null) {
    return 'error';
  }

  const rawDisplayName = readString(body, 'displayName');
  const displayName =
    rawDisplayName !== null && rawDisplayName.length > 0 ? rawDisplayName : username;

  return { username, displayName, csrf, hubLoginUrl };
}

/**
 * Huỷ phiên ở server rồi luôn đưa người chơi về hub (kể cả khi request lỗi),
 * để không mắc kẹt ở màn hình game với cookie đã chết.
 */
export async function logout(hubLoginUrl: string, csrf: string): Promise<void> {
  const target = hubLoginUrl.trim();
  try {
    await fetch(LOGOUT_URL, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-CSRF-Token': csrf },
    });
  } catch {
    // Bỏ qua: vẫn phải rời game về hub.
  }
  if (target.length > 0) window.location.assign(target);
}
