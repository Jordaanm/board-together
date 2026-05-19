import { describe, test, expect } from 'vitest';
import { isPermutation } from './isPermutation';

describe('isPermutation', () => {
  test('identical arrays', () => {
    expect(isPermutation(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(true);
  });

  test('reordered arrays', () => {
    expect(isPermutation(['a', 'b', 'c'], ['c', 'a', 'b'])).toBe(true);
  });

  test('empty arrays', () => {
    expect(isPermutation([], [])).toBe(true);
  });

  test('different lengths', () => {
    expect(isPermutation(['a', 'b'], ['a', 'b', 'c'])).toBe(false);
    expect(isPermutation(['a', 'b', 'c'], ['a', 'b'])).toBe(false);
  });

  test('missing element', () => {
    expect(isPermutation(['a', 'b', 'c'], ['a', 'b', 'd'])).toBe(false);
  });

  test('extra element instead of one', () => {
    expect(isPermutation(['a', 'b', 'c'], ['a', 'b', 'b'])).toBe(false);
  });

  test('duplicate elements are honoured by multiplicity', () => {
    expect(isPermutation(['a', 'a', 'b'], ['a', 'b', 'a'])).toBe(true);
    expect(isPermutation(['a', 'a', 'b'], ['a', 'b', 'b'])).toBe(false);
  });

  test('works on numbers', () => {
    expect(isPermutation([1, 2, 3], [3, 2, 1])).toBe(true);
    expect(isPermutation([1, 2, 3], [1, 2, 4])).toBe(false);
  });
});
