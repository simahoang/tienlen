import type { ConnectionStatus } from '../net/client';

const SERVER_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  ROOM_NOT_FOUND: 'Không tìm thấy phòng. Kiểm tra lại mã phòng.',
  ROOM_FULL: 'Phòng đã đủ người (tối đa 4).',
  GAME_IN_PROGRESS: 'Ván đã bắt đầu, không thể vào lúc này.',
  ROOM_NOT_LOBBY: 'Ván đã bắt đầu, không đổi trạng thái phòng chờ được nữa.',
  NOT_HOST: 'Chỉ chủ phòng mới được bắt đầu ván.',
  NOT_ENOUGH_PLAYERS: 'Cần ít nhất 2 người để bắt đầu.',
  ALREADY_IN_ROOM: 'Bạn đã ở trong một phòng.',
  NOT_IN_ROOM: 'Bạn chưa ở trong phòng nào.',
  INVALID_NICKNAME: 'Nickname phải từ 1 đến 20 ký tự.',
  INVALID_CODE: 'Mã phòng phải gồm 4-6 ký tự A-Z hoặc 0-9.',
  INVALID_CARDS: 'Bộ bài chọn không hợp lệ.',
  INVALID_TOKEN: 'Phiên chơi không còn hợp lệ.',
  RECONNECT_EXPIRED: 'Đã quá hạn nối lại (3 phút). Hãy vào phòng mới.',
  RECONNECT_WINDOW_EXPIRED: 'Không nối lại được sau 3 phút. Hãy vào phòng mới.',
  RATE_LIMITED: 'Bạn thao tác quá nhanh, chờ một chút rồi thử lại.',
  SERVER_FULL: 'Server đang đầy phòng, thử lại sau.',
  ROOM_NOT_PLAYING: 'Ván chưa bắt đầu hoặc đã kết thúc.',
  CLIENT_OFFLINE: 'Chưa kết nối tới server.',
  SESSION_REPLACED: 'Tài khoản đã được mở ở tab khác. Tab này đã ngừng kết nối.',
  GAME_OVER: 'Ván đã kết thúc.',
  NOT_IN_GAME: 'Bạn không còn trong ván này.',
  NOT_YOUR_TURN: 'Chưa tới lượt của bạn.',
  ALREADY_PASSED: 'Bạn đã bỏ lượt trong vòng này.',
  PLAYER_OUT: 'Bạn đã hết bài.',
  INVALID_INTENT: 'Thao tác không hợp lệ.',
  CARD_NOT_IN_HAND: 'Bạn không có lá bài đó trên tay.',
  INVALID_COMBO: 'Các lá đã chọn không tạo thành bộ hợp lệ.',
  INVALID_BEAT: 'Bộ bài không đánh được bộ đang có trên bàn.',
  FIRST_MUST_CONTAIN_3S: 'Lượt đầu phải đánh bộ có chứa 3♠.',
  CANNOT_PASS_WHEN_LEADING: 'Bạn đang mở vòng, không được bỏ lượt.',
  ALREADY_SURRENDERED: 'Bạn đã rời ván này.',
  TURN_PAUSED: 'Lượt đang tạm dừng cho cửa sổ chặt.',
  WINDOW_CLOSED: 'Cửa sổ chặt đã đóng.',
  INVALID_TARGET: 'Mục tiêu chặt không hợp lệ.',
  LOST_RACE: 'Người khác đã chặt trước.',
};

export function formatServerError(code: string, serverMessage: string): string {
  const mapped = SERVER_ERROR_MESSAGES[code];
  if (mapped) return mapped;
  const fallback = serverMessage.trim();
  if (fallback.length > 0) return `Không thực hiện được: ${fallback}`;
  return 'Có lỗi xảy ra, vui lòng thử lại.';
}

export function formatConnectionStatus(status: ConnectionStatus): string | null {
  switch (status) {
    case 'idle':
      return 'Chưa kết nối.';
    case 'connecting':
      return 'Đang kết nối tới server…';
    case 'reconnecting':
      return 'Mất kết nối. Đang tự nối lại…';
    case 'closed':
      return 'Đã mất kết nối tới server.';
    case 'open':
      return null;
  }
}
