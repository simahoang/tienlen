const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

export * from './types';
export * from './rng';
export * from './deck';
export * from './deal';
export * from './combos';
export * from './compare';
export * from './toiTrang';
export * from './game';
export * from './scoring';
export * from './replay';

export function isValidRulesVersion(version: string): boolean {
  return SEMVER_PATTERN.test(version);
}
