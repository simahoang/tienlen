import rawRules from '../../data/rules.json';
import type {
  ChopAttacker,
  ChopTarget,
  ComboKey,
  FallbackPlace,
  FirstPlayerSubsequentConfig,
  Rank,
  StartingPlayerConfig,
  Suit,
  ToiTrangCombo,
} from '../rules/types';

export interface DeckRules {
  readonly cardCount: number;
  readonly ranks: readonly Rank[];
  readonly suits: readonly Suit[];
  readonly suitSymbols: Readonly<Record<Suit, string>>;
  readonly rankLabels: Readonly<Record<Rank, string>>;
  readonly orderNote: string;
}

export interface DealPlayerCount {
  readonly players: number;
  readonly cardsPerPlayer: number;
  readonly deadCards: number;
}

export interface DealRules {
  readonly cardsPerPlayer: number;
  readonly playerCounts: readonly DealPlayerCount[];
  readonly note: string;
}

export interface ComboSpec {
  readonly cards?: number;
  readonly minCards?: number;
  readonly maxCards?: number;
  readonly noTwo?: boolean;
  readonly playable?: boolean;
  readonly toiTrangOnly?: boolean;
  readonly description?: string;
}

export type VariantStatus =
  | 'enabled'
  | 'disabled'
  | 'allowedNoPenalty'
  | 'forbidden'
  | 'sameAs4';

export interface VariantSpec {
  readonly id: string;
  readonly key: string;
  readonly status: VariantStatus;
  readonly note?: string;
}

export interface RulesFlags {
  readonly toiTrang: boolean;
  readonly chatHeo: boolean;
  readonly blackRedSplit: boolean;
  readonly thoiHai: boolean;
  readonly thoiHang: boolean;
  readonly haiVeCuoi: boolean;
  readonly baBichCuoi: boolean;
  readonly denBai: boolean;
  readonly sanhChuaHai: boolean;
  readonly chatNgoaiLuot: boolean;
}

export interface ToiTrangRules {
  readonly enabled: boolean;
  readonly combos: readonly ToiTrangCombo[];
  readonly priority: readonly ToiTrangCombo[];
  readonly timing: string;
  readonly tieBreak: string;
  readonly noSuitSplit: boolean;
  /** true: lá lẻ thứ 13 của sảnh 3→A được là 2 (§2.2 rev 4). */
  readonly sanh13LaLeDuocLaHai: boolean;
  /** true: tứ quý được đếm là 2 đôi khi xét "6 đôi bất kỳ" (§2.2 rev 4). */
  readonly tuQuyDemHaiDoi: boolean;
  readonly note: string;
}

export type ChopMatrix = Readonly<Record<ChopAttacker, Readonly<Record<ChopTarget, boolean>>>>;

export interface ChatHeoRules {
  readonly enabled: boolean;
  readonly matrix: ChopMatrix;
  readonly crossTypeNoRankCompare: boolean;
  readonly unlimitedStacking: boolean;
  readonly orderNote: string;
}

export interface DenBaiRules {
  readonly enabled: boolean;
  readonly pointsRef: string;
  readonly chatChongGanhChuoi: boolean;
  readonly chatChongTheoGiaTriMucTieu: boolean;
  readonly note: string;
}

export interface ChatNgoaiLuotRules {
  readonly enabled: boolean;
  readonly windowMs: number;
  readonly passedCannotChop: boolean;
  readonly pauseTurnTimer: boolean;
  readonly tieBreak: string;
  readonly opensOn: readonly ChopTarget[];
  readonly note: string;
}

export interface ScoreValues {
  readonly heoDen: number;
  readonly heoDo: number;
  readonly baDoiThong: number;
  readonly tuQuy: number;
  readonly bonDoiThong: number;
}

export interface ScoringRules {
  readonly unit: string;
  readonly places: Readonly<Record<'nhat' | 'nhi' | 'ba' | 'bet', number>>;
  readonly toiTrang: { readonly points: number };
  readonly values: ScoreValues;
  readonly den: { readonly giu13La: number };
  readonly haiVeCuoi: number;
  readonly baBichCuoi: number;
  readonly note: string;
}

export interface TurnRules {
  readonly turnTimerMs: number;
  readonly countdownWarnMs: number;
  readonly autoPassWhenMidTrick: boolean;
  readonly autoPlayLowestWhenLeading: boolean;
}

/** doc-4 §4.2/§4.3 — luật đi trước ván ≥ 2 của tour. */
export type FirstPlayerSubsequentRules = FirstPlayerSubsequentConfig & {
  readonly fallbackOrder: readonly FallbackPlace[];
  readonly newSeatLast: boolean;
  readonly emptyFallback: string;
  readonly timeoutLeadPlaysLowest: boolean;
  readonly appliesTo: string;
  readonly note: string;
};

/** doc-4 §3/§10 — vòng đời tour nhiều ván. */
export interface TourRules {
  readonly allowedCounts: readonly number[];
  readonly min: number;
  readonly max: number;
  readonly defaultCount: number;
  readonly resultDisplayMs: number;
  readonly autoNext: boolean;
  readonly requireReady: boolean;
  readonly allowSkip: boolean;
  readonly minPlayersToStart: number;
  readonly resumeCountdownMs: number;
  readonly afkKickConsecutiveRounds: number;
  readonly earlyEndByHost: boolean;
  readonly allowMidJoin: boolean;
  readonly tourTieBreak: readonly string[];
  readonly note: string;
}

export interface RulesConfig {
  readonly schemaVersion: number;
  readonly rulesVersion: string;
  readonly sourceDoc: string;
  readonly deck: DeckRules;
  readonly deal: DealRules;
  readonly firstPlayer: StartingPlayerConfig;
  readonly firstPlayerSubsequent: FirstPlayerSubsequentRules;
  readonly tour: TourRules;
  readonly variants: readonly VariantSpec[];
  readonly flags: RulesFlags;
  readonly combos: Readonly<Record<ComboKey, ComboSpec>>;
  readonly toiTrang: ToiTrangRules;
  readonly chatHeo: ChatHeoRules;
  readonly blackRedSplit: boolean;
  readonly thoiHai: { readonly enabled: boolean };
  readonly thoiHang: { readonly enabled: boolean };
  readonly haiVeCuoi: { readonly allowed: boolean; readonly penalty: number };
  readonly baBichCuoi: { readonly enabled: boolean; readonly bonus: number };
  readonly denBai: DenBaiRules;
  readonly sanhChuaHai: boolean;
  readonly chatNgoaiLuot: ChatNgoaiLuotRules;
  readonly scoring: ScoringRules;
  readonly turn: TurnRules;
}

const RANK_VALUES = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'] as const;
const SUIT_VALUES = ['spades', 'clubs', 'diamonds', 'hearts'] as const;
const COMBO_KEYS = [
  'rac',
  'doi',
  'samCo',
  'sanh',
  'tuQuy',
  'baDoiThong',
  'bonDoiThong',
  'namDoiThong',
] as const;
const CHOP_ATTACKERS = ['baDoiThong', 'tuQuy', 'bonDoiThong'] as const;
const CHOP_TARGETS = ['singleTwo', 'pairTwo', 'baDoiThong', 'tuQuy', 'bonDoiThong'] as const;
const TOI_TRANG_COMBOS = [
  'sanh3toA',
  'namDoiThong',
  'sauDoiThong',
  'sauDoiBatKy',
  'tuQuyHai',
] as const;
const FLAG_KEYS = [
  'toiTrang',
  'chatHeo',
  'blackRedSplit',
  'thoiHai',
  'thoiHang',
  'haiVeCuoi',
  'baBichCuoi',
  'denBai',
  'sanhChuaHai',
  'chatNgoaiLuot',
] as const;
const VARIANT_STATUSES = ['enabled', 'disabled', 'allowedNoPenalty', 'forbidden', 'sameAs4'] as const;

const RANK_SET: ReadonlySet<string> = new Set(RANK_VALUES);
const SUIT_SET: ReadonlySet<string> = new Set(SUIT_VALUES);

function fail(path: string, message: string): never {
  throw new Error(`rules.json: ${path} ${message}`);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'phải là object');
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'phải là mảng');
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'phải là string không rỗng');
  return value;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'phải là boolean');
  return value;
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'phải là number hữu hạn');
  return value;
}

function asInteger(value: unknown, path: string, min = 0): number {
  const parsed = asNumber(value, path);
  if (!Number.isInteger(parsed) || parsed < min) fail(path, `phải là số nguyên >= ${min}`);
  return parsed;
}

function asStringArray(value: unknown, path: string): string[] {
  return asArray(value, path).map((item, index) => asString(item, `${path}[${index}]`));
}

function asIntegerArray(value: unknown, path: string, min = 0): number[] {
  return asArray(value, path).map((item, index) => asInteger(item, `${path}[${index}]`, min));
}

function asRank(value: unknown, path: string): Rank {
  const rank = asString(value, path);
  if (!RANK_SET.has(rank)) fail(path, `rank không hợp lệ: ${rank}`);
  return rank as Rank;
}

function asSuit(value: unknown, path: string): Suit {
  const suit = asString(value, path);
  if (!SUIT_SET.has(suit)) fail(path, `chất không hợp lệ: ${suit}`);
  return suit as Suit;
}

function validateDeck(root: Record<string, unknown>): void {
  const deck = asRecord(root['deck'], 'deck');
  const ranks = asStringArray(deck['ranks'], 'deck.ranks');
  const suits = asStringArray(deck['suits'], 'deck.suits');
  ranks.forEach((rank, index) => asRank(rank, `deck.ranks[${index}]`));
  suits.forEach((suit, index) => asSuit(suit, `deck.suits[${index}]`));
  if (new Set(ranks).size !== ranks.length) fail('deck.ranks', 'có rank trùng');
  if (new Set(suits).size !== suits.length) fail('deck.suits', 'có chất trùng');

  const cardCount = asInteger(deck['cardCount'], 'deck.cardCount', 1);
  if (cardCount !== ranks.length * suits.length) {
    fail('deck.cardCount', `phải bằng ranks x suits = ${ranks.length * suits.length}`);
  }

  const suitSymbols = asRecord(deck['suitSymbols'], 'deck.suitSymbols');
  for (const suit of suits) {
    asString(suitSymbols[suit], `deck.suitSymbols.${suit}`);
  }
  const rankLabels = asRecord(deck['rankLabels'], 'deck.rankLabels');
  for (const rank of ranks) {
    asString(rankLabels[rank], `deck.rankLabels.${rank}`);
  }
  asString(deck['orderNote'], 'deck.orderNote');
}

function validateDeal(root: Record<string, unknown>): void {
  const deal = asRecord(root['deal'], 'deal');
  const cardsPerPlayer = asInteger(deal['cardsPerPlayer'], 'deal.cardsPerPlayer', 1);
  const entries = asArray(deal['playerCounts'], 'deal.playerCounts');
  if (entries.length === 0) fail('deal.playerCounts', 'phải có ít nhất 1 cấu hình');
  const cardCount = asInteger(asRecord(root['deck'], 'deck')['cardCount'], 'deck.cardCount', 1);
  const seenPlayers = new Set<number>();
  entries.forEach((entry, index) => {
    const path = `deal.playerCounts[${index}]`;
    const row = asRecord(entry, path);
    const players = asInteger(row['players'], `${path}.players`, 2);
    const perPlayer = asInteger(row['cardsPerPlayer'], `${path}.cardsPerPlayer`, 1);
    const deadCards = asInteger(row['deadCards'], `${path}.deadCards`, 0);
    if (perPlayer !== cardsPerPlayer) {
      fail(`${path}.cardsPerPlayer`, `phải bằng deal.cardsPerPlayer = ${cardsPerPlayer}`);
    }
    if (deadCards !== cardCount - players * perPlayer) {
      fail(`${path}.deadCards`, `phải bằng ${cardCount} - ${players} x ${perPlayer}`);
    }
    if (seenPlayers.has(players)) fail(`${path}.players`, `trùng cấu hình ${players} người`);
    seenPlayers.add(players);
  });
  for (const required of [2, 3, 4]) {
    if (!seenPlayers.has(required)) fail('deal.playerCounts', `thiếu cấu hình ${required} người`);
  }
  asString(deal['note'], 'deal.note');
}

function validateFirstPlayer(root: Record<string, unknown>): void {
  const firstPlayer = asRecord(root['firstPlayer'], 'firstPlayer');
  asBoolean(firstPlayer['mustContain3S'], 'firstPlayer.mustContain3S');
  const primary = asRecord(firstPlayer['primaryCard'], 'firstPlayer.primaryCard');
  asRank(primary['rank'], 'firstPlayer.primaryCard.rank');
  asSuit(primary['suit'], 'firstPlayer.primaryCard.suit');
  const fallbackSuits = asStringArray(firstPlayer['fallbackSuits'], 'firstPlayer.fallbackSuits');
  fallbackSuits.forEach((suit, index) => asSuit(suit, `firstPlayer.fallbackSuits[${index}]`));
  asString(firstPlayer['fallbackRule'], 'firstPlayer.fallbackRule');
  asString(firstPlayer['rejectCode'], 'firstPlayer.rejectCode');
}

const FALLBACK_PLACES = ['nhi', 'ba', 'bet'] as const;

function validateFirstPlayerSubsequent(root: Record<string, unknown>): void {
  const config = asRecord(root['firstPlayerSubsequent'], 'firstPlayerSubsequent');
  asBoolean(config['winnerLeads'], 'firstPlayerSubsequent.winnerLeads');
  asBoolean(config['firstMoveFree'], 'firstPlayerSubsequent.firstMoveFree');
  asString(config['fallback'], 'firstPlayerSubsequent.fallback');
  const order = asStringArray(config['fallbackOrder'], 'firstPlayerSubsequent.fallbackOrder');
  if (order.length === 0) fail('firstPlayerSubsequent.fallbackOrder', 'phải có ít nhất 1 hạng');
  for (const place of order) {
    if (!(FALLBACK_PLACES as readonly string[]).includes(place)) {
      fail('firstPlayerSubsequent.fallbackOrder', `hạng không hợp lệ: ${place}`);
    }
  }
  if (new Set(order).size !== order.length) {
    fail('firstPlayerSubsequent.fallbackOrder', 'có hạng trùng');
  }
  asBoolean(config['newSeatLast'], 'firstPlayerSubsequent.newSeatLast');
  asString(config['emptyFallback'], 'firstPlayerSubsequent.emptyFallback');
  asBoolean(config['timeoutLeadPlaysLowest'], 'firstPlayerSubsequent.timeoutLeadPlaysLowest');
  const rejectCode = config['rejectCode'];
  if (rejectCode !== null && rejectCode !== undefined) {
    asString(rejectCode, 'firstPlayerSubsequent.rejectCode');
  }
  asString(config['appliesTo'], 'firstPlayerSubsequent.appliesTo');
  asString(config['note'], 'firstPlayerSubsequent.note');
}

function validateTour(root: Record<string, unknown>): void {
  const tour = asRecord(root['tour'], 'tour');
  const allowed = asIntegerArray(tour['allowedCounts'], 'tour.allowedCounts', 2);
  if (allowed.length === 0) fail('tour.allowedCounts', 'phải có ít nhất 1 giá trị');
  if (new Set(allowed).size !== allowed.length) fail('tour.allowedCounts', 'có giá trị trùng');
  const min = asInteger(tour['min'], 'tour.min', 2);
  const max = asInteger(tour['max'], 'tour.max', 2);
  if (min > max) fail('tour.min', 'phải nhỏ hơn hoặc bằng tour.max');
  const defaultCount = asInteger(tour['defaultCount'], 'tour.defaultCount', 2);
  if (defaultCount < min || defaultCount > max) {
    fail('tour.defaultCount', `phải nằm trong ${min}..${max}`);
  }
  asInteger(tour['resultDisplayMs'], 'tour.resultDisplayMs', 0);
  asBoolean(tour['autoNext'], 'tour.autoNext');
  asBoolean(tour['requireReady'], 'tour.requireReady');
  asBoolean(tour['allowSkip'], 'tour.allowSkip');
  asInteger(tour['minPlayersToStart'], 'tour.minPlayersToStart', 2);
  asInteger(tour['resumeCountdownMs'], 'tour.resumeCountdownMs', 0);
  asInteger(tour['afkKickConsecutiveRounds'], 'tour.afkKickConsecutiveRounds', 1);
  asBoolean(tour['earlyEndByHost'], 'tour.earlyEndByHost');
  asBoolean(tour['allowMidJoin'], 'tour.allowMidJoin');
  const tieBreak = asStringArray(tour['tourTieBreak'], 'tour.tourTieBreak');
  if (tieBreak.length === 0) fail('tour.tourTieBreak', 'phải có ít nhất 1 tiêu chí');
  asString(tour['note'], 'tour.note');
}

function validateFlags(root: Record<string, unknown>): Record<string, boolean> {
  const flags = asRecord(root['flags'], 'flags');
  const parsed: Record<string, boolean> = {};
  for (const key of FLAG_KEYS) {
    parsed[key] = asBoolean(flags[key], `flags.${key}`);
  }
  return parsed;
}

function validateVariants(root: Record<string, unknown>): void {
  const variants = asArray(root['variants'], 'variants');
  const seen = new Set<string>();
  variants.forEach((entry, index) => {
    const path = `variants[${index}]`;
    const variant = asRecord(entry, path);
    const id = asString(variant['id'], `${path}.id`);
    if (!/^V([1-9]|10)$/.test(id)) fail(`${path}.id`, `mã biến thể không hợp lệ: ${id}`);
    if (seen.has(id)) fail(`${path}.id`, `biến thể trùng: ${id}`);
    seen.add(id);
    asString(variant['key'], `${path}.key`);
    const status = asString(variant['status'], `${path}.status`);
    if (!(VARIANT_STATUSES as readonly string[]).includes(status)) {
      fail(`${path}.status`, `trạng thái không hợp lệ: ${status}`);
    }
  });
}

function validateCombos(root: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const combos = asRecord(root['combos'], 'combos');
  const parsed: Record<string, Record<string, unknown>> = {};
  for (const key of COMBO_KEYS) {
    const path = `combos.${key}`;
    const combo = asRecord(combos[key], path);
    for (const field of ['cards', 'minCards', 'maxCards'] as const) {
      const value = combo[field];
      if (value !== undefined) asInteger(value, `${path}.${field}`, 1);
    }
    for (const field of ['noTwo', 'playable', 'toiTrangOnly'] as const) {
      const value = combo[field];
      if (value !== undefined) asBoolean(value, `${path}.${field}`);
    }
    if (combo['description'] !== undefined) asString(combo['description'], `${path}.description`);
    parsed[key] = combo;
  }
  return parsed;
}

function validateToiTrang(root: Record<string, unknown>): void {
  const toiTrang = asRecord(root['toiTrang'], 'toiTrang');
  asBoolean(toiTrang['enabled'], 'toiTrang.enabled');
  const combos = asStringArray(toiTrang['combos'], 'toiTrang.combos');
  if (combos.length === 0) fail('toiTrang.combos', 'phải có ít nhất 1 tổ hợp');
  for (const combo of combos) {
    if (!(TOI_TRANG_COMBOS as readonly string[]).includes(combo)) {
      fail('toiTrang.combos', `tổ hợp không hợp lệ: ${combo}`);
    }
  }
  const priority = asStringArray(toiTrang['priority'], 'toiTrang.priority');
  for (const combo of priority) {
    if (!(TOI_TRANG_COMBOS as readonly string[]).includes(combo)) {
      fail('toiTrang.priority', `tổ hợp không hợp lệ: ${combo}`);
    }
  }
  if (new Set(priority).size !== priority.length) fail('toiTrang.priority', 'có tổ hợp trùng');
  const comboSet = new Set(combos);
  if (priority.length !== comboSet.size || !priority.every((combo) => comboSet.has(combo))) {
    fail('toiTrang.priority', 'phải chứa đúng các tổ hợp trong toiTrang.combos');
  }
  asString(toiTrang['timing'], 'toiTrang.timing');
  asString(toiTrang['tieBreak'], 'toiTrang.tieBreak');
  asBoolean(toiTrang['noSuitSplit'], 'toiTrang.noSuitSplit');
  asBoolean(toiTrang['sanh13LaLeDuocLaHai'], 'toiTrang.sanh13LaLeDuocLaHai');
  asBoolean(toiTrang['tuQuyDemHaiDoi'], 'toiTrang.tuQuyDemHaiDoi');
  asString(toiTrang['note'], 'toiTrang.note');
}

function validateChatHeo(root: Record<string, unknown>): void {
  const chatHeo = asRecord(root['chatHeo'], 'chatHeo');
  asBoolean(chatHeo['enabled'], 'chatHeo.enabled');
  const matrix = asRecord(chatHeo['matrix'], 'chatHeo.matrix');
  for (const attacker of CHOP_ATTACKERS) {
    const row = asRecord(matrix[attacker], `chatHeo.matrix.${attacker}`);
    for (const target of CHOP_TARGETS) {
      asBoolean(row[target], `chatHeo.matrix.${attacker}.${target}`);
    }
  }
  asBoolean(chatHeo['crossTypeNoRankCompare'], 'chatHeo.crossTypeNoRankCompare');
  asBoolean(chatHeo['unlimitedStacking'], 'chatHeo.unlimitedStacking');
  asString(chatHeo['orderNote'], 'chatHeo.orderNote');
}

function validateScoring(root: Record<string, unknown>): void {
  const scoring = asRecord(root['scoring'], 'scoring');
  asString(scoring['unit'], 'scoring.unit');
  const places = asRecord(scoring['places'], 'scoring.places');
  for (const place of ['nhat', 'nhi', 'ba', 'bet'] as const) {
    asNumber(places[place], `scoring.places.${place}`);
  }
  const toiTrang = asRecord(scoring['toiTrang'], 'scoring.toiTrang');
  asInteger(toiTrang['points'], 'scoring.toiTrang.points', 0);
  const values = asRecord(scoring['values'], 'scoring.values');
  for (const key of ['heoDen', 'heoDo', 'baDoiThong', 'tuQuy', 'bonDoiThong'] as const) {
    asInteger(values[key], `scoring.values.${key}`, 0);
  }
  const den = asRecord(scoring['den'], 'scoring.den');
  asInteger(den['giu13La'], 'scoring.den.giu13La', 0);
  asNumber(scoring['haiVeCuoi'], 'scoring.haiVeCuoi');
  asNumber(scoring['baBichCuoi'], 'scoring.baBichCuoi');
  asString(scoring['note'], 'scoring.note');
}

function validateChatNgoaiLuot(root: Record<string, unknown>): void {
  const chop = asRecord(root['chatNgoaiLuot'], 'chatNgoaiLuot');
  asBoolean(chop['enabled'], 'chatNgoaiLuot.enabled');
  asInteger(chop['windowMs'], 'chatNgoaiLuot.windowMs', 1);
  asBoolean(chop['passedCannotChop'], 'chatNgoaiLuot.passedCannotChop');
  asBoolean(chop['pauseTurnTimer'], 'chatNgoaiLuot.pauseTurnTimer');
  asString(chop['tieBreak'], 'chatNgoaiLuot.tieBreak');
  const opensOn = asStringArray(chop['opensOn'], 'chatNgoaiLuot.opensOn');
  for (const target of opensOn) {
    if (!(CHOP_TARGETS as readonly string[]).includes(target)) {
      fail('chatNgoaiLuot.opensOn', `mục tiêu không hợp lệ: ${target}`);
    }
  }
  asString(chop['note'], 'chatNgoaiLuot.note');
}

function validateBooleans(root: Record<string, unknown>): void {
  asBoolean(root['blackRedSplit'], 'blackRedSplit');
  asBoolean(root['sanhChuaHai'], 'sanhChuaHai');
  asBoolean(asRecord(root['thoiHai'], 'thoiHai')['enabled'], 'thoiHai.enabled');
  asBoolean(asRecord(root['thoiHang'], 'thoiHang')['enabled'], 'thoiHang.enabled');
  const haiVeCuoi = asRecord(root['haiVeCuoi'], 'haiVeCuoi');
  asBoolean(haiVeCuoi['allowed'], 'haiVeCuoi.allowed');
  asNumber(haiVeCuoi['penalty'], 'haiVeCuoi.penalty');
  const baBichCuoi = asRecord(root['baBichCuoi'], 'baBichCuoi');
  asBoolean(baBichCuoi['enabled'], 'baBichCuoi.enabled');
  asNumber(baBichCuoi['bonus'], 'baBichCuoi.bonus');
  const denBai = asRecord(root['denBai'], 'denBai');
  asBoolean(denBai['enabled'], 'denBai.enabled');
  asString(denBai['pointsRef'], 'denBai.pointsRef');
  asBoolean(denBai['chatChongGanhChuoi'], 'denBai.chatChongGanhChuoi');
  asBoolean(denBai['chatChongTheoGiaTriMucTieu'], 'denBai.chatChongTheoGiaTriMucTieu');
  asString(denBai['note'], 'denBai.note');
  const turn = asRecord(root['turn'], 'turn');
  asInteger(turn['turnTimerMs'], 'turn.turnTimerMs', 1);
  asInteger(turn['countdownWarnMs'], 'turn.countdownWarnMs', 0);
  asBoolean(turn['autoPassWhenMidTrick'], 'turn.autoPassWhenMidTrick');
  asBoolean(turn['autoPlayLowestWhenLeading'], 'turn.autoPlayLowestWhenLeading');
}

function validateConsistency(
  root: Record<string, unknown>,
  flags: Record<string, boolean>,
  combos: Record<string, Record<string, unknown>>,
): void {
  const sanitize = (value: unknown): boolean | undefined =>
    typeof value === 'boolean' ? value : undefined;

  const pairs: ReadonlyArray<readonly [string, string, unknown]> = [
    ['toiTrang', 'flags.toiTrang', asRecord(root['toiTrang'], 'toiTrang')['enabled']],
    ['chatHeo', 'flags.chatHeo', asRecord(root['chatHeo'], 'chatHeo')['enabled']],
    ['denBai', 'flags.denBai', asRecord(root['denBai'], 'denBai')['enabled']],
    [
      'chatNgoaiLuot',
      'flags.chatNgoaiLuot',
      asRecord(root['chatNgoaiLuot'], 'chatNgoaiLuot')['enabled'],
    ],
  ];
  for (const [name, flagPath, blockValue] of pairs) {
    if (sanitize(blockValue) !== flags[name]) {
      fail(flagPath, `không khớp ${name}.enabled`);
    }
  }

  if (flags['blackRedSplit'] !== asBoolean(root['blackRedSplit'], 'blackRedSplit')) {
    fail('flags.blackRedSplit', 'không khớp blackRedSplit');
  }
  const noTwo = combos['sanh']?.['noTwo'];
  if (typeof noTwo === 'boolean' && flags['sanhChuaHai'] === noTwo) {
    fail('flags.sanhChuaHai', 'phải là phủ định của combos.sanh.noTwo');
  }
}

export function parseRulesConfig(raw: unknown): RulesConfig {
  const root = asRecord(raw, '$');
  const rulesVersion = asString(root['rulesVersion'], 'rulesVersion');
  if (!/^\d+\.\d+\.\d+$/.test(rulesVersion)) {
    fail('rulesVersion', 'phải có dạng semver x.y.z');
  }
  asInteger(root['schemaVersion'], 'schemaVersion', 1);
  asString(root['sourceDoc'], 'sourceDoc');

  validateDeck(root);
  validateDeal(root);
  validateFirstPlayer(root);
  validateFirstPlayerSubsequent(root);
  validateTour(root);
  validateVariants(root);
  const flags = validateFlags(root);
  const combos = validateCombos(root);
  validateToiTrang(root);
  validateScoring(root);
  validateChatHeo(root);
  validateChatNgoaiLuot(root);
  validateBooleans(root);
  validateConsistency(root, flags, combos);

  return raw as RulesConfig;
}

export const rules: RulesConfig = parseRulesConfig(rawRules);

/**
 * Shim tương thích cho scaffold `src/main.ts` cũ (main chưa được cập nhật trong
 * phạm vi task-6). Code mới dùng `rules` và các khối flag tương ứng.
 */
export const rulesPlaceholder = {
  rulesVersion: rules.rulesVersion,
  enabled: Object.entries(rules.flags)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key),
} as const;
