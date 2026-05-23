import { describe, test, expect } from 'vitest';
import { parsePdfRef, formatPdfRef, isPdfRef } from './pdfRef';

describe('parsePdfRef', () => {
  test('parses canonical pdf-refs', () => {
    expect(parsePdfRef('pdf:custom:foo/page/3')).toEqual({ slug: 'custom:foo', page: 3 });
    expect(parsePdfRef('pdf:custom:my-doc/page/1')).toEqual({ slug: 'custom:my-doc', page: 1 });
    expect(parsePdfRef('pdf:custom:nested/path/page/42')).toEqual({ slug: 'custom:nested/path', page: 42 });
  });

  test('rejects missing pdf: prefix', () => {
    expect(parsePdfRef('custom:foo/page/3')).toBeNull();
    expect(parsePdfRef('foo/page/3')).toBeNull();
  });

  test('rejects missing /page/ segment', () => {
    expect(parsePdfRef('pdf:custom:foo')).toBeNull();
    expect(parsePdfRef('pdf:custom:foo/3')).toBeNull();
  });

  test('rejects missing or unknown namespace', () => {
    expect(parsePdfRef('pdf:/page/3')).toBeNull();
    expect(parsePdfRef('pdf:weird:foo/page/3')).toBeNull();
  });

  test('rejects non-integer page', () => {
    expect(parsePdfRef('pdf:custom:foo/page/abc')).toBeNull();
    expect(parsePdfRef('pdf:custom:foo/page/1.5')).toBeNull();
    expect(parsePdfRef('pdf:custom:foo/page/1e2')).toBeNull();
  });

  test('rejects page ≤ 0', () => {
    expect(parsePdfRef('pdf:custom:foo/page/0')).toBeNull();
    expect(parsePdfRef('pdf:custom:foo/page/-1')).toBeNull();
  });

  test('rejects leading-zero pages (canonical form only)', () => {
    expect(parsePdfRef('pdf:custom:foo/page/01')).toBeNull();
  });

  test('rejects non-string / empty inputs', () => {
    expect(parsePdfRef('')).toBeNull();
    expect(parsePdfRef(undefined)).toBeNull();
    expect(parsePdfRef(null)).toBeNull();
    expect(parsePdfRef(42)).toBeNull();
  });
});

describe('formatPdfRef', () => {
  test('produces canonical pdf-ref', () => {
    expect(formatPdfRef('custom:foo', 3)).toBe('pdf:custom:foo/page/3');
    expect(formatPdfRef('custom:my-doc', 1)).toBe('pdf:custom:my-doc/page/1');
  });

  test('round-trips with parsePdfRef', () => {
    const ref = formatPdfRef('custom:foo', 7);
    expect(parsePdfRef(ref)).toEqual({ slug: 'custom:foo', page: 7 });
  });

  test('throws on bad page', () => {
    expect(() => formatPdfRef('custom:foo', 0)).toThrow();
    expect(() => formatPdfRef('custom:foo', -1)).toThrow();
    expect(() => formatPdfRef('custom:foo', 1.5)).toThrow();
  });
});

describe('isPdfRef', () => {
  test('true only for valid pdf-refs', () => {
    expect(isPdfRef('pdf:custom:foo/page/1')).toBe(true);
    expect(isPdfRef('custom:foo')).toBe(false);
    expect(isPdfRef('custom:foo:0')).toBe(false);
    expect(isPdfRef('http://x/a.pdf')).toBe(false);
  });
});
