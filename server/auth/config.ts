/** Cấu hình auth của Game2, nạp một lần từ env và inject vào server. */

export interface AuthConfig {
  /** URL đăng nhập của hub; cũng là nơi redirect khi chưa có phiên. */
  readonly hubLoginUrl: string;
  /** Secret hub dùng để ký ticket (khác SESSION_SECRET). */
  readonly hubTicketSecret: string;
  /** Secret Game2 dùng để ký cookie phiên. */
  readonly sessionSecret: string;
  readonly sessionTtlSeconds: number;
  readonly hubTicketTtlSeconds: number;
  readonly cookieSecure: boolean;
  /** Danh sách origin được phép mở WebSocket; rỗng = so với header Host. */
  readonly allowedOrigins: readonly string[];
}

const DEFAULT_SESSION_TTL_SECONDS = 43_200;
const DEFAULT_HUB_TICKET_TTL_SECONDS = 60;

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`[game2-auth] thiếu biến môi trường bắt buộc: ${key}`);
  }
  return value;
}

function integerEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseHubLoginUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('[game2-auth] HUB_LOGIN_URL không phải URL hợp lệ');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('[game2-auth] HUB_LOGIN_URL phải dùng http hoặc https');
  }
  return parsed.toString();
}

function parseOrigins(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];
  const origins: string[] = [];
  for (const chunk of raw.split(',')) {
    const origin = chunk.trim().replace(/\/+$/, '');
    if (origin.length > 0) origins.push(origin);
  }
  return origins;
}

/** Fail-fast: thiếu HUB_LOGIN_URL / HUB_TICKET_SECRET / SESSION_SECRET thì không chạy. */
export function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const hubLoginUrl = parseHubLoginUrl(required(env, 'HUB_LOGIN_URL'));
  const hubTicketSecret = required(env, 'HUB_TICKET_SECRET');
  const sessionSecret = required(env, 'SESSION_SECRET');
  const cookieSecureRaw = env['COOKIE_SECURE']?.trim().toLowerCase();
  return {
    hubLoginUrl,
    hubTicketSecret,
    sessionSecret,
    sessionTtlSeconds: integerEnv(env, 'SESSION_TTL_SECONDS', DEFAULT_SESSION_TTL_SECONDS),
    hubTicketTtlSeconds: integerEnv(
      env,
      'HUB_TICKET_TTL_SECONDS',
      DEFAULT_HUB_TICKET_TTL_SECONDS,
    ),
    cookieSecure: cookieSecureRaw === '1' || cookieSecureRaw === 'true',
    allowedOrigins: parseOrigins(env['ALLOWED_ORIGINS']),
  };
}
