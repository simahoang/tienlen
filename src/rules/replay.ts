import {
  applyIntent,
  applyTimeout,
  createGame,
  type GameEvent,
  type GameRulesInput,
  type GameState,
  type Intent,
} from './game';
import { calculateScore, type ScoreResult } from './scoring';
import type { Card } from './types';

export interface ReplayIntentAction {
  readonly intent: Intent;
  /** Giờ server của action; mặc định dùng `state.lastNowMs`. */
  readonly nowMs?: number;
}

/** Auto timeout do server kích hoạt (không phải intent từ client). */
export interface ReplayTimeoutAction {
  readonly timeout: true;
  /** Giờ server của timeout; mặc định dùng `state.lastNowMs`. */
  readonly nowMs?: number;
}

export type ReplayAction = ReplayIntentAction | ReplayTimeoutAction;

export interface ReplayOptions {
  /** Hook test: dựng ván với tay bài cố định thay vì chia từ seed. */
  readonly hands?: readonly (readonly Card[])[];
  readonly startingPlayerIndex?: number;
  /** doc-4 §4.2: ván ≥ 2 trong tour — ghế đi trước do kết quả ván trước quyết định. */
  readonly firstSeat?: number;
  readonly firstMoveFree?: boolean;
  readonly roundIndex?: number;
}

export interface ReplayResult {
  readonly state: GameState;
  readonly score: ScoreResult | null;
  readonly events: readonly GameEvent[];
}

/**
 * Dựng lại ván từ seed + danh sách action theo đúng thứ tự §3.5.
 * Sai thứ tự/luật → throw kèm chỉ số action và mã lỗi.
 */
export function replay(
  seed: number,
  players: number,
  rules: GameRulesInput,
  actions: readonly ReplayAction[],
  options: ReplayOptions = {},
): ReplayResult {
  let state = createGame({
    seed,
    players,
    rules,
    ...(options.hands ? { hands: options.hands } : {}),
    ...(options.startingPlayerIndex === undefined
      ? {}
      : { startingPlayerIndex: options.startingPlayerIndex }),
    ...(options.firstSeat === undefined ? {} : { firstSeat: options.firstSeat }),
    ...(options.firstMoveFree === undefined ? {} : { firstMoveFree: options.firstMoveFree }),
    ...(options.roundIndex === undefined ? {} : { roundIndex: options.roundIndex }),
  });
  const events: GameEvent[] = [];

  actions.forEach((action, index) => {
    const options = action.nowMs === undefined ? {} : { nowMs: action.nowMs };
    const isTimeout = 'timeout' in action;
    const result = isTimeout
      ? applyTimeout(state, options)
      : applyIntent(state, action.intent, options);
    if (result.error) {
      const label = isTimeout
        ? `timeout ghế ${state.turn}`
        : `${action.intent.type} ghế ${action.intent.seat}`;
      throw new Error(
        `replay: action #${index} (${label}) lỗi ${result.error.code}: ${result.error.message}`,
      );
    }
    state = result.state;
    events.push(...result.events);
  });

  return {
    state,
    score: state.phase === 'finished' ? calculateScore(state) : null,
    events,
  };
}
