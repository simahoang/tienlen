/**
 * PRNG nhỏ, tự viết để không thêm dependency. Cùng seed luôn ra cùng dãy số.
 */
export type Rng = () => number;

export function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) {
    throw new RangeError(`seed không hợp lệ: ${String(seed)}`);
  }
  return Math.trunc(seed) >>> 0;
}

export function mulberry32(seed: number): Rng {
  let state = normalizeSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const current = result[i];
    const target = result[j];
    if (current === undefined || target === undefined) {
      throw new Error('shuffle: chỉ số ngoài mảng');
    }
    result[i] = target;
    result[j] = current;
  }
  return result;
}
