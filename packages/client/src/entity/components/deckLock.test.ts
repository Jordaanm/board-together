import { describe, test, expect } from 'vitest';
import { isLockedAgainst } from './deckLock';

describe('isLockedAgainst', () => {
  test('null lock → false for every caller', () => {
    expect(isLockedAgainst({ searchLockedBy: null }, null)).toBe(false);
    expect(isLockedAgainst({ searchLockedBy: null }, 0)).toBe(false);
    expect(isLockedAgainst({ searchLockedBy: null }, 3)).toBe(false);
  });

  test('own-seat lock → false (caller is the holder)', () => {
    expect(isLockedAgainst({ searchLockedBy: 0 }, 0)).toBe(false);
    expect(isLockedAgainst({ searchLockedBy: 5 }, 5)).toBe(false);
  });

  test('other-seat lock → true', () => {
    expect(isLockedAgainst({ searchLockedBy: 0 }, 1)).toBe(true);
    expect(isLockedAgainst({ searchLockedBy: 7 }, 2)).toBe(true);
  });

  test('other-seat lock → true even for null caller', () => {
    expect(isLockedAgainst({ searchLockedBy: 0 }, null)).toBe(true);
  });
});
