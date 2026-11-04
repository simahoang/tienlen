import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AuthConfig } from './config';

/** Danh tính rút từ ticket của hub; phiên Game2 (csrf) do Game2 tự phát. */
export interface HubTicketClaims {
  readonly username: string;
  readonly displayName: string;
  readonly exp: number;
}

const VERSION_PREFIX = 'v1';
const AUDIENCE = 'game2';
const CLOCK_SKEW_SECONDS = 60;
const MAX_TICKET_LENGTH = 4096;
const B64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** jti đã dùng -> exp; chống replay trong phạm vi một process. */
const usedJti = new Map<string, number>();

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sign(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

function decodeB64Url(value: string): Buffer | null {
  if (!B64URL_PATTERN.test(value)) return null;
  const buffer = Buffer.from(value, 'base64url');
  return buffer.length > 0 ? buffer : null;
}

function pruneUsedJti(nowSec: number): void {
  for (const [jti, exp] of usedJti) {
    if (exp + CLOCK_SKEW_SECONDS < nowSec) usedJti.delete(jti);
  }
}

/** Trả về null cho mọi trường hợp không hợp lệ; không bao giờ throw. */
export function verifyHubTicket(
  ticket: string,
  config: AuthConfig,
  nowSec: number,
): HubTicketClaims | null {
  if (ticket.length === 0 || ticket.length > MAX_TICKET_LENGTH) return null;
  const parts = ticket.split('.');
  if (parts.length !== 3) return null;
  const [version, body, macPart] = parts;
  if (version !== VERSION_PREFIX) return null;
  if (body === undefined || macPart === undefined) return null;
  const given = decodeB64Url(macPart);
  const rawBody = decodeB64Url(body);
  if (given === null || rawBody === null) return null;
  const expected = sign(`${VERSION_PREFIX}.${body}`, config.hubTicketSecret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed['v'] !== 1 || parsed['aud'] !== AUDIENCE) return null;
  const username = parsed['u'];
  const displayName = parsed['d'];
  const issuedAt = parsed['iat'];
  const expiresAt = parsed['exp'];
  const jti = parsed['jti'];
  if (typeof username !== 'string' || username.length === 0) return null;
  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  if (typeof jti !== 'string' || jti.length === 0 || jti.length > 128) return null;
  if (expiresAt <= nowSec - CLOCK_SKEW_SECONDS) return null;
  if (issuedAt > nowSec + CLOCK_SKEW_SECONDS) return null;

  pruneUsedJti(nowSec);
  if (usedJti.has(jti)) return null;
  usedJti.set(jti, Math.max(expiresAt, nowSec));

  return {
    username,
    displayName: typeof displayName === 'string' && displayName.length > 0 ? displayName : username,
    exp: expiresAt,
  };
}
