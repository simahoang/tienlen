import type { WebSocket } from 'ws';

/** Danh tính đã xác thực của một kết nối; server là nguồn sự thật. */
export interface Principal {
  readonly username: string;
  readonly displayName: string;
  /** Token CSRF của phiên hiện tại (không gửi qua WebSocket). */
  readonly csrf: string;
  /** Hạn phiên, epoch giây. */
  readonly exp: number;
}

/** Socket đã qua upgrade auth; `principal` do server gắn, client không đặt được. */
export interface AuthedSocket extends WebSocket {
  principal?: Principal;
}
