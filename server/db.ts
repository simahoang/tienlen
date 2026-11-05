import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync as DatabaseSyncInstance } from 'node:sqlite';
import { rules } from '../src/data/index';
import type { GameRulesInput, GameState, Intent } from '../src/rules/index';
import { replay, type ReplayAction, type ReplayResult } from '../src/rules/replay';

// Vite 5 chưa nhận `node:sqlite` là builtin của Node 24, nên nạp runtime bằng require.
// Nạp lazy + try/catch: Node <24 thiếu module này thì server chỉ cảnh báo, không chết.
const nodeRequire = createRequire(import.meta.url);

type DatabaseSyncConstructor = new (path: string) => DatabaseSyncInstance;
let cachedDatabaseSync: DatabaseSyncConstructor | null | undefined;

function loadDatabaseSync(): DatabaseSyncConstructor | null {
  if (cachedDatabaseSync !== undefined) return cachedDatabaseSync;
  try {
    const module = nodeRequire('node:sqlite') as { DatabaseSync: DatabaseSyncConstructor };
    cachedDatabaseSync = module.DatabaseSync;
  } catch {
    cachedDatabaseSync = null;
  }
  return cachedDatabaseSync;
}

export interface StoreLogger {
  warn(message: string): void;
}

const consoleLogger: StoreLogger = {
  warn: (message: string): void => {
    console.warn(message);
  },
};

export interface StoredPlayer {
  readonly seat: number;
  readonly nickname: string;
  readonly userId: number | null;
}

export interface MatchResultRecord {
  readonly ranking: GameState['ranking'];
  readonly scores: readonly number[];
  readonly actionCount: number;
  readonly rulesVersion: string;
}

export interface MatchConfig {
  readonly windowMs: number;
  readonly turnMs: number;
  /** doc-4 §4: thông tin cần để replay đúng ván trong tour. */
  readonly roundIndex?: number;
  readonly firstSeat?: number;
  readonly firstMoveFree?: boolean;
}

export interface StoredMatch {
  readonly id: number;
  readonly roomCode: string;
  readonly seed: number;
  readonly rulesVersion: string;
  readonly config: MatchConfig | null;
  readonly players: readonly StoredPlayer[];
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly result: MatchResultRecord | null;
  /** doc-4 §7: match thuộc tour nào + ván thứ mấy. */
  readonly tourId: string | null;
  readonly roundIndex: number | null;
}

export interface StoredAction {
  readonly id: number;
  readonly matchId: number;
  readonly seq: number;
  readonly seat: number;
  readonly type: string;
  readonly payload: unknown;
  /** 'ok' nếu engine chấp nhận; mã lỗi (RATE_LIMITED, NOT_YOUR_TURN, ...) nếu bị reject. */
  readonly result: string;
  readonly createdAt: string;
}

export interface CreateMatchInput {
  readonly roomCode: string;
  readonly seed: number;
  readonly rulesVersion: string;
  readonly config: MatchConfig;
  readonly players: readonly StoredPlayer[];
  readonly tourId?: string | null;
  readonly roundIndex?: number | null;
}

/** doc-4 §7: bảng `tours`. */
export interface TourRecord {
  readonly tourId: string;
  readonly roomCode: string;
  readonly totalRounds: number;
  readonly createdBy: string;
  readonly createdAt?: string;
}

export type TourStatus = 'running' | 'paused' | 'finished' | 'incomplete';

/** doc-4 §7: bảng `tour_scores`, cập nhật cuối mỗi ván. */
export interface TourScoreRecord {
  readonly tourId: string;
  readonly account: string;
  readonly nickname: string;
  readonly seat: number;
  readonly pointsTotal: number;
  readonly wins: number;
  readonly chatThu: number;
  readonly chatTra: number;
  readonly thoiTra: number;
  readonly denTra: number;
  readonly roundsPlayed: number;
  readonly joinedMid: boolean;
  readonly leftMid: boolean;
}

export interface AppendActionInput {
  readonly matchId: number;
  readonly seq: number;
  readonly seat: number;
  readonly type: string;
  readonly payload: unknown;
  /** Mặc định 'ok'. Replay chỉ dùng action 'ok'. */
  readonly result?: string;
}

export type ReplayErrorCode =
  | 'DB_UNAVAILABLE'
  | 'MATCH_NOT_FOUND'
  | 'MATCH_NOT_FINISHED'
  | 'RULES_VERSION_MISMATCH'
  | 'ACTION_SEQ_GAP'
  | 'INVALID_ACTION'
  | 'REPLAY_MISMATCH';

export class ReplayError extends Error {
  readonly code: ReplayErrorCode;

  constructor(code: ReplayErrorCode, message: string) {
    super(message);
    this.name = 'ReplayError';
    this.code = code;
  }
}

export interface ReplayMatchResult {
  readonly match: StoredMatch;
  readonly replayed: ReplayResult;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code TEXT NOT NULL,
  seed TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  config_json TEXT,
  players_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  result_json TEXT,
  tour_id TEXT,
  round_index INTEGER
);
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  seat INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT 'ok',
  created_at TEXT NOT NULL,
  UNIQUE (match_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_actions_match_seq ON actions (match_id, seq);
CREATE TABLE IF NOT EXISTS tours (
  tour_id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL,
  total_rounds INTEGER NOT NULL,
  status TEXT NOT NULL,
  rounds_played INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS tour_scores (
  tour_id TEXT NOT NULL,
  account TEXT NOT NULL,
  nickname TEXT NOT NULL,
  seat INTEGER NOT NULL,
  points_total INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  chat_thu INTEGER NOT NULL DEFAULT 0,
  chat_tra INTEGER NOT NULL DEFAULT 0,
  thoi_tra INTEGER NOT NULL DEFAULT 0,
  den_tra INTEGER NOT NULL DEFAULT 0,
  rounds_played INTEGER NOT NULL DEFAULT 0,
  joined_mid INTEGER NOT NULL DEFAULT 0,
  left_mid INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tour_id, account)
);
`;

/** Migration nhẹ cho DB cũ: thêm cột nếu chưa có (tên cột cố định trong code). */
function ensureColumn(
  db: DatabaseSyncInstance,
  table: string,
  column: string,
  definition: string,
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (rows.some((row) => row['name'] === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function integer(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  return fallback;
}

function parseIntegerText(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return 0;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/**
 * Lưu ván chơi vào SQLite bằng `node:sqlite` (built-in, không dependency native).
 * Mọi lỗi DB đều được nuốt + log cảnh báo để game loop tiếp tục chạy.
 */
export class GameStore {
  readonly path: string;
  private readonly logger: StoreLogger;
  private db: DatabaseSyncInstance | null = null;

  constructor(path: string, logger: StoreLogger = consoleLogger) {
    this.path = path;
    this.logger = logger;
    this.db = this.open(path);
  }

  private open(path: string): DatabaseSyncInstance | null {
    try {
      if (path !== ':memory:') {
        mkdirSync(dirname(resolve(path)), { recursive: true });
      }
      const DatabaseSync = loadDatabaseSync();
      if (!DatabaseSync) {
        this.warn(
          'node:sqlite không khả dụng (cần Node >=24), tiếp tục chạy không lưu DB',
        );
        return null;
      }
      const db = new DatabaseSync(path);
      if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
      db.exec(SCHEMA);
      ensureColumn(db, 'matches', 'config_json', 'TEXT');
      ensureColumn(db, 'actions', 'result', "TEXT NOT NULL DEFAULT 'ok'");
      ensureColumn(db, 'matches', 'tour_id', 'TEXT');
      ensureColumn(db, 'matches', 'round_index', 'INTEGER');
      // Index trên cột migrate phải tạo SAU ensureColumn, nếu không DB legacy sẽ lỗi "no such column".
      db.exec('CREATE INDEX IF NOT EXISTS idx_matches_tour ON matches (tour_id, round_index);');
      return db;
    } catch (error) {
      this.warn(
        `không mở được SQLite tại "${path}", tiếp tục chạy không lưu DB: ${describe(error)}`,
      );
      return null;
    }
  }

  get enabled(): boolean {
    return this.db !== null;
  }

  private warn(message: string): void {
    this.logger.warn(`[game2-db] ${message}`);
  }

  private now(): string {
    return new Date().toISOString();
  }

  createUser(nickname: string): number | null {
    const db = this.db;
    if (!db) return null;
    try {
      const info = db
        .prepare('INSERT INTO users (nickname, created_at) VALUES (?, ?)')
        .run(nickname, this.now());
      return integer(info.lastInsertRowid);
    } catch (error) {
      this.warn(`ghi users thất bại: ${describe(error)}`);
      return null;
    }
  }

  createMatch(input: CreateMatchInput): number | null {
    const db = this.db;
    if (!db) return null;
    try {
      const info = db
        .prepare(
          'INSERT INTO matches (room_code, seed, rules_version, config_json, players_json, started_at, tour_id, round_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          input.roomCode,
          String(input.seed),
          input.rulesVersion,
          JSON.stringify(input.config),
          JSON.stringify(input.players),
          this.now(),
          input.tourId ?? null,
          input.roundIndex ?? null,
        );
      return integer(info.lastInsertRowid);
    } catch (error) {
      this.warn(`ghi matches thất bại: ${describe(error)}`);
      return null;
    }
  }

  /** doc-4 §7: mở tour khi chia ván 1. */
  createTour(input: TourRecord): boolean {
    const db = this.db;
    if (!db) return false;
    try {
      db.prepare(
        'INSERT OR IGNORE INTO tours (tour_id, room_code, total_rounds, status, rounds_played, created_by, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      ).run(
        input.tourId,
        input.roomCode,
        input.totalRounds,
        'running',
        input.createdBy,
        input.createdAt ?? this.now(),
      );
      return true;
    } catch (error) {
      this.warn(`ghi tours thất bại: ${describe(error)}`);
      return false;
    }
  }

  /** Ghi đè điểm tour của 1 người sau mỗi ván (idempotent theo tour_id + account). */
  upsertTourScore(input: TourScoreRecord): boolean {
    const db = this.db;
    if (!db) return false;
    try {
      db.prepare(
        `INSERT INTO tour_scores (tour_id, account, nickname, seat, points_total, wins, chat_thu, chat_tra, thoi_tra, den_tra, rounds_played, joined_mid, left_mid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tour_id, account) DO UPDATE SET
           nickname = excluded.nickname,
           seat = excluded.seat,
           points_total = excluded.points_total,
           wins = excluded.wins,
           chat_thu = excluded.chat_thu,
           chat_tra = excluded.chat_tra,
           thoi_tra = excluded.thoi_tra,
           den_tra = excluded.den_tra,
           rounds_played = excluded.rounds_played,
           joined_mid = excluded.joined_mid,
           left_mid = excluded.left_mid`,
      ).run(
        input.tourId,
        input.account,
        input.nickname,
        input.seat,
        input.pointsTotal,
        input.wins,
        input.chatThu,
        input.chatTra,
        input.thoiTra,
        input.denTra,
        input.roundsPlayed,
        input.joinedMid ? 1 : 0,
        input.leftMid ? 1 : 0,
      );
      return true;
    } catch (error) {
      this.warn(`ghi tour_scores ${input.tourId}/${input.account} thất bại: ${describe(error)}`);
      return false;
    }
  }

  finishTour(tourId: string, status: TourStatus, roundsPlayed: number): boolean {
    const db = this.db;
    if (!db) return false;
    try {
      const info = db
        .prepare('UPDATE tours SET status = ?, rounds_played = ?, finished_at = ? WHERE tour_id = ?')
        .run(status, roundsPlayed, this.now(), tourId);
      return integer(info.changes) > 0;
    } catch (error) {
      this.warn(`cập nhật tour ${tourId} thất bại: ${describe(error)}`);
      return false;
    }
  }

  /** Các match của 1 tour, sắp theo ván — dùng để đối chiếu/replay độc lập từng ván. */
  listTourMatches(tourId: string): StoredMatch[] {
    const db = this.db;
    if (!db) return [];
    try {
      return db
        .prepare('SELECT * FROM matches WHERE tour_id = ? ORDER BY round_index, id')
        .all(tourId)
        .map((row) => toStoredMatch(row));
    } catch (error) {
      this.warn(`đọc matches tour ${tourId} thất bại: ${describe(error)}`);
      return [];
    }
  }

  appendAction(input: AppendActionInput): boolean {
    const db = this.db;
    if (!db) return false;
    try {
      db.prepare(
        'INSERT INTO actions (match_id, seq, seat, type, payload_json, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        input.matchId,
        input.seq,
        input.seat,
        input.type,
        JSON.stringify(input.payload),
        input.result ?? 'ok',
        this.now(),
      );
      return true;
    } catch (error) {
      this.warn(`ghi action match ${input.matchId} seq ${input.seq} thất bại: ${describe(error)}`);
      return false;
    }
  }

  finishMatch(matchId: number, result: MatchResultRecord): boolean {
    const db = this.db;
    if (!db) return false;
    try {
      const info = db
        .prepare('UPDATE matches SET ended_at = ?, result_json = ? WHERE id = ? AND ended_at IS NULL')
        .run(this.now(), JSON.stringify(result), matchId);
      return integer(info.changes) > 0;
    } catch (error) {
      this.warn(`cập nhật kết quả match ${matchId} thất bại: ${describe(error)}`);
      return false;
    }
  }

  listMatches(): StoredMatch[] {
    const db = this.db;
    if (!db) return [];
    try {
      return db
        .prepare('SELECT * FROM matches ORDER BY id')
        .all()
        .map((row) => toStoredMatch(row));
    } catch (error) {
      this.warn(`đọc matches thất bại: ${describe(error)}`);
      return [];
    }
  }

  getMatch(matchId: number): StoredMatch | null {
    const db = this.db;
    if (!db) return null;
    try {
      const row = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
      return row ? toStoredMatch(row) : null;
    } catch (error) {
      this.warn(`đọc match ${matchId} thất bại: ${describe(error)}`);
      return null;
    }
  }

  getActions(matchId: number): StoredAction[] {
    const db = this.db;
    if (!db) return [];
    try {
      return db
        .prepare('SELECT * FROM actions WHERE match_id = ? ORDER BY seq')
        .all(matchId)
        .map((row) => toStoredAction(row));
    } catch (error) {
      this.warn(`đọc actions match ${matchId} thất bại: ${describe(error)}`);
      return [];
    }
  }

  /** Chỉ action engine đã chấp nhận — dùng cho replay, bỏ qua intent bị reject/rate limit. */
  getAcceptedActions(matchId: number): StoredAction[] {
    return this.getActions(matchId).filter((action) => action.result === 'ok');
  }

  /**
   * Dựng lại ván từ seed + action log rồi đối chiếu với `result_json` đã lưu.
   * Lệch → throw `ReplayError('REPLAY_MISMATCH')` kèm dữ liệu 2 bên.
   */
  replayMatch(matchId: number): ReplayMatchResult {
    if (!this.db) throw new ReplayError('DB_UNAVAILABLE', 'DB không mở được, không thể replay');
    const match = this.getMatch(matchId);
    if (!match) throw new ReplayError('MATCH_NOT_FOUND', `không tìm thấy match ${matchId}`);
    if (!match.result) {
      throw new ReplayError('MATCH_NOT_FINISHED', `match ${matchId} chưa có result_json`);
    }
    if (match.rulesVersion !== rules.rulesVersion) {
      throw new ReplayError(
        'RULES_VERSION_MISMATCH',
        `match ${matchId} dùng rules ${match.rulesVersion}, engine hiện tại ${rules.rulesVersion}`,
      );
    }
    if (match.players.length < 2) {
      throw new ReplayError('INVALID_ACTION', `match ${matchId} không đủ người chơi`);
    }

    const rows = this.getAcceptedActions(matchId);
    const actions: ReplayAction[] = [];
    let previousSeq = 0;
    for (const row of rows) {
      if (row.seq <= previousSeq) {
        throw new ReplayError(
          'ACTION_SEQ_GAP',
          `match ${matchId} action seq không tăng dần: seq ${row.seq} sau ${previousSeq}`,
        );
      }
      previousSeq = row.seq;
      actions.push(toReplayAction(row));
    }

    // Dùng đúng config đã lưu của match (windowMs ảnh hưởng engine; turnMs lưu để đối chiếu).
    const matchRules: GameRulesInput = {
      ...rules,
      chatNgoaiLuot: {
        ...rules.chatNgoaiLuot,
        windowMs: match.config?.windowMs ?? rules.chatNgoaiLuot.windowMs,
      },
    };

    let replayed: ReplayResult;
    try {
      replayed = replay(match.seed, match.players.length, matchRules, actions, {
        ...(match.config?.roundIndex === undefined
          ? {}
          : { roundIndex: match.config.roundIndex }),
        ...(match.config?.firstSeat === undefined ? {} : { firstSeat: match.config.firstSeat }),
        ...(match.config?.firstMoveFree === undefined
          ? {}
          : { firstMoveFree: match.config.firstMoveFree }),
      });
    } catch (error) {
      if (error instanceof ReplayError) throw error;
      throw new ReplayError(
        'INVALID_ACTION',
        `match ${matchId} replay lỗi engine: ${describe(error)}`,
      );
    }
    if (replayed.state.phase !== 'finished') {
      throw new ReplayError(
        'REPLAY_MISMATCH',
        `match ${matchId} replay chưa kết thúc (phase ${replayed.state.phase})`,
      );
    }

    const expectedRanking = JSON.stringify(match.result.ranking);
    const actualRanking = JSON.stringify(replayed.state.ranking);
    if (expectedRanking !== actualRanking) {
      throw new ReplayError(
        'REPLAY_MISMATCH',
        `match ${matchId} ranking lệch: DB ${expectedRanking}, replay ${actualRanking}`,
      );
    }

    const expectedScores = JSON.stringify(match.result.scores);
    const actualScores = JSON.stringify(replayed.score?.deltas ?? null);
    if (expectedScores !== actualScores) {
      throw new ReplayError(
        'REPLAY_MISMATCH',
        `match ${matchId} scores lệch: DB ${expectedScores}, replay ${actualScores}`,
      );
    }

    if (match.result.actionCount !== replayed.state.actionCount) {
      throw new ReplayError(
        'REPLAY_MISMATCH',
        `match ${matchId} actionCount lệch: DB ${match.result.actionCount}, replay ${replayed.state.actionCount}`,
      );
    }

    return { match, replayed };
  }

  close(): void {
    if (!this.db) return;
    try {
      this.db.close();
    } catch (error) {
      this.warn(`đóng DB thất bại: ${describe(error)}`);
    } finally {
      this.db = null;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toStoredMatch(row: Record<string, unknown>): StoredMatch {
  const rawPlayers = parseJson(row['players_json']);
  const players: StoredPlayer[] = Array.isArray(rawPlayers)
    ? rawPlayers.filter(isRecord).map((entry) => ({
        seat: integer(entry['seat'], -1),
        nickname: text(entry['nickname'], ''),
        userId: typeof entry['userId'] === 'number' ? entry['userId'] : null,
      }))
    : [];

  const rawResult = parseJson(row['result_json']);
  let result: MatchResultRecord | null = null;
  if (isRecord(rawResult) && Array.isArray(rawResult['ranking']) && Array.isArray(rawResult['scores'])) {
    result = {
      ranking: rawResult['ranking'] as MatchResultRecord['ranking'],
      scores: rawResult['scores'].filter((value): value is number => typeof value === 'number'),
      actionCount: integer(rawResult['actionCount']),
      rulesVersion: text(rawResult['rulesVersion']),
    };
  }

  const rawConfig = parseJson(row['config_json']);
  let config: MatchConfig | null = null;
  if (
    isRecord(rawConfig) &&
    typeof rawConfig['windowMs'] === 'number' &&
    typeof rawConfig['turnMs'] === 'number'
  ) {
    config = {
      windowMs: rawConfig['windowMs'],
      turnMs: rawConfig['turnMs'],
      ...(typeof rawConfig['roundIndex'] === 'number'
        ? { roundIndex: rawConfig['roundIndex'] }
        : {}),
      ...(typeof rawConfig['firstSeat'] === 'number' ? { firstSeat: rawConfig['firstSeat'] } : {}),
      ...(typeof rawConfig['firstMoveFree'] === 'boolean'
        ? { firstMoveFree: rawConfig['firstMoveFree'] }
        : {}),
    };
  }

  return {
    id: integer(row['id']),
    roomCode: text(row['room_code']),
    seed: parseIntegerText(row['seed']),
    rulesVersion: text(row['rules_version']),
    config,
    players,
    startedAt: text(row['started_at']),
    endedAt: typeof row['ended_at'] === 'string' ? row['ended_at'] : null,
    result,
    tourId: typeof row['tour_id'] === 'string' ? row['tour_id'] : null,
    roundIndex: typeof row['round_index'] === 'number' ? row['round_index'] : null,
  };
}

function toStoredAction(row: Record<string, unknown>): StoredAction {
  return {
    id: integer(row['id']),
    matchId: integer(row['match_id']),
    seq: integer(row['seq']),
    seat: integer(row['seat'], -1),
    type: text(row['type']),
    payload: parseJson(row['payload_json']),
    result: text(row['result'], 'ok'),
    createdAt: text(row['created_at']),
  };
}

function toReplayAction(action: StoredAction): ReplayAction {
  if (!isRecord(action.payload)) {
    throw new ReplayError(
      'INVALID_ACTION',
      `action ${action.id} (${action.type}) payload không phải object`,
    );
  }
  const nowMs = action.payload['nowMs'];
  const now = typeof nowMs === 'number' ? { nowMs } : {};
  if (action.type === 'timeout') return { timeout: true, ...now };
  const intent = action.payload['intent'];
  if (!isRecord(intent) || typeof intent['type'] !== 'string') {
    throw new ReplayError(
      'INVALID_ACTION',
      `action ${action.id} (${action.type}) thiếu intent hợp lệ`,
    );
  }
  return { intent: intent as unknown as Intent, ...now };
}
