import { timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import type { AuthConfig } from './config';
import type { Principal } from './principal';
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  issueSession,
  readCookie,
  readSession,
  serializeSessionCookie,
} from './session';
import { verifyHubTicket } from './ticket';

export interface HttpHandlerOptions {
  /** Thư mục build của client; mặc định `<cwd>/dist`. */
  readonly distDir?: string;
}

const STATIC_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function sendJson(res: ServerResponse, status: number, body: JsonValue): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function errorBody(
  code: string,
  message: string,
  extras?: { readonly hubLoginUrl?: string },
): JsonValue {
  return { ok: false, error: { code, message }, ...extras };
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function currentPrincipal(req: IncomingMessage, config: AuthConfig): Principal | null {
  const raw = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
  return readSession(raw, config.sessionSecret);
}

function hubLoginUrlWithError(config: AuthConfig, code: string): string {
  try {
    const url = new URL(config.hubLoginUrl);
    url.searchParams.set('error', code);
    return url.toString();
  } catch {
    return config.hubLoginUrl;
  }
}

function isGetLike(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

function serveFile(
  res: ServerResponse,
  distDir: string,
  pathname: string,
): Promise<boolean> {
  return (async (): Promise<boolean> => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    if (decoded.includes('\u0000')) return false;
    const relative = decoded.replace(/^[/\\]+/, '');
    if (relative.length === 0) return false;
    const target = resolve(distDir, relative);
    if (target !== distDir && !target.startsWith(distDir + sep)) return false;

    let filePath = target;
    try {
      const info = await stat(filePath);
      if (info.isDirectory()) {
        filePath = resolve(filePath, 'index.html');
        const nested = await stat(filePath);
        if (!nested.isFile()) return false;
      } else if (!info.isFile()) {
        return false;
      }
    } catch {
      return false;
    }

    let content: Buffer;
    try {
      content = await readFile(filePath);
    } catch {
      return false;
    }

    const extension = extname(filePath).toLowerCase();
    const contentType = STATIC_TYPES[extension] ?? 'application/octet-stream';
    const cacheControl =
      extension === '.html' ? 'no-store' : 'public, max-age=3600';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
      'Cache-Control': cacheControl,
    });
    res.end(content);
    return true;
  })();
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: AuthConfig,
  distDir: string,
): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://game2.local');
  } catch {
    sendJson(res, 400, errorBody('bad_request', 'URL không hợp lệ'));
    return;
  }
  const pathname = url.pathname;

  if (pathname === '/health') {
    if (!isGetLike(method)) {
      sendJson(res, 405, errorBody('method_not_allowed', 'chỉ hỗ trợ GET'));
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/auth/hub') {
    if (!isGetLike(method)) {
      sendJson(res, 405, errorBody('method_not_allowed', 'chỉ hỗ trợ GET'));
      return;
    }
    const ticket = url.searchParams.get('ticket') ?? '';
    const claims = verifyHubTicket(ticket, config, Math.floor(Date.now() / 1000));
    if (claims === null) {
      redirect(res, hubLoginUrlWithError(config, 'session'));
      return;
    }
    const session = issueSession(
      { username: claims.username, displayName: claims.displayName },
      config.sessionSecret,
      config.sessionTtlSeconds,
    );
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': serializeSessionCookie(session.cookie, config),
      'Cache-Control': 'no-store',
    });
    res.end();
    return;
  }

  if (pathname === '/auth/me') {
    if (!isGetLike(method)) {
      sendJson(res, 405, errorBody('method_not_allowed', 'chỉ hỗ trợ GET'));
      return;
    }
    const principal = currentPrincipal(req, config);
    if (principal === null) {
      sendJson(res, 401, { ok: false, hubLoginUrl: config.hubLoginUrl });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      username: principal.username,
      displayName: principal.displayName,
      csrf: principal.csrf,
      hubLoginUrl: config.hubLoginUrl,
    });
    return;
  }

  if (pathname === '/auth/logout') {
    if (method !== 'POST') {
      sendJson(res, 405, errorBody('method_not_allowed', 'chỉ hỗ trợ POST'));
      return;
    }
    const principal = currentPrincipal(req, config);
    if (principal === null) {
      sendJson(res, 403, errorBody('session_required', 'không có phiên hợp lệ', { hubLoginUrl: config.hubLoginUrl }));
      return;
    }
    const token = req.headers['x-csrf-token'];
    if (typeof token !== 'string' || !constantTimeEquals(token, principal.csrf)) {
      sendJson(res, 403, errorBody('csrf_invalid', 'CSRF token không hợp lệ', { hubLoginUrl: config.hubLoginUrl }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': clearSessionCookie(config),
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ ok: true, hubLoginUrl: config.hubLoginUrl }));
    return;
  }

  if (pathname === '/') {
    if (!isGetLike(method)) {
      sendJson(res, 405, errorBody('method_not_allowed', 'chỉ hỗ trợ GET'));
      return;
    }
    if (currentPrincipal(req, config) === null) {
      redirect(res, config.hubLoginUrl);
      return;
    }
    const served = await serveFile(res, distDir, '/index.html');
    if (!served) {
      sendJson(res, 404, errorBody('not_built', 'client chưa build (thiếu dist/index.html)'));
    }
    return;
  }

  if (!isGetLike(method)) {
    sendJson(res, 405, errorBody('method_not_allowed', 'chỉ hỗ trợ GET'));
    return;
  }
  const served = await serveFile(res, distDir, pathname);
  if (!served) {
    sendJson(res, 404, errorBody('not_found', 'không tìm thấy tài nguyên'));
  }
}

/** Handler HTTP cùng origin với WS: auth, health và static dist/. */
export function createHttpHandler(
  config: AuthConfig,
  options: HttpHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const distDir = resolve(options.distDir ?? resolve(process.cwd(), 'dist'));
  return (req, res) => {
    handleRequest(req, res, config, distDir).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, errorBody('internal_error', 'lỗi máy chủ'));
        return;
      }
      res.end();
    });
  };
}
