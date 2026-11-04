import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthConfig } from './config';
import type { Principal } from './principal';

interface SessionPayload {
  readonly v: 1;
  readonly u: string;
  readonly d: string;
  readonly csrf: string;
  readonly exp: number;
}

export const SESSION_COOKIE_NAME = 'g2_session';

const VERSION_PREFIX = 'v1';
const CSRF_BYTES = 32;
const B64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sign(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

function toB64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function decodeB64Url(value: string): Buffer | null {
  if (!B64URL_PATTERN.test(value)) return null;
  const buffer = Buffer.from(value, 'base64url');
  return buffer.length > 0 ? buffer : null;
}

export function issueSession(
  principal: Pick<Principal, 'username' | 'displayName'>,
  secret: string,
  ttlSeconds: number,
): { readonly cookie: string; readonly principal: Principal } {
  const payload: SessionPayload = {
    v: 1,
    u: principal.username,
    d: principal.displayName,
    csrf: randomBytes(CSRF_BYTES).toString('hex'),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = toB64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const mac = toB64Url(sign(`${VERSION_PREFIX}.${body}`, secret));
  return {
    cookie: `${VERSION_PREFIX}.${body}.${mac}`,
    principal: {
      username: payload.u,
      displayName: payload.d,
      csrf: payload.csrf,
      exp: payload.exp,
    },
  };
}

export function readSession(
  raw: string | undefined,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Principal | null {
  if (raw === undefined || raw.length === 0) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [version, body, macPart] = parts;
  if (version !== VERSION_PREFIX) return null;
  if (body === undefined || macPart === undefined) return null;
  const given = decodeB64Url(macPart);
  if (given === null) return null;
  const expected = sign(`${VERSION_PREFIX}.${body}`, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const rawBody = decodeB64Url(body);
  if (rawBody === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed['v'] !== 1) return null;
  const username = parsed['u'];
  const displayName = parsed['d'];
  const csrf = parsed['csrf'];
  const exp = parsed['exp'];
  if (typeof username !== 'string' || username.length === 0) return null;
  if (typeof displayName !== 'string') return null;
  if (typeof csrf !== 'string' || csrf.length === 0) return null;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= nowSec) return null;
  return { username, displayName, csrf, exp };
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const chunk of header.split(';')) {
    const index = chunk.indexOf('=');
    if (index < 0) continue;
    if (chunk.slice(0, index).trim() !== name) continue;
    const raw = chunk.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

export function serializeSessionCookie(cookie: string, config: AuthConfig): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(cookie)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${config.sessionTtlSeconds}`,
  ];
  if (config.cookieSecure) attributes.push('Secure');
  return attributes.join('; ');
}

export function clearSessionCookie(config: AuthConfig): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (config.cookieSecure) attributes.push('Secure');
  return attributes.join('; ');
}
