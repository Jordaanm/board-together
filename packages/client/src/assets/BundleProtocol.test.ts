import { describe, test, expect } from 'vitest';
import {
  BundleProtocolError,
  decodeControl,
  decodeFrame,
  encodeControl,
  encodeFrame,
  type BundleFrame,
} from './BundleProtocol';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('BundleProtocol — control messages', () => {
  test('bundle-request round-trips', () => {
    const msg = { type: 'bundle-request', requestId: 42, hash: HASH_A } as const;
    expect(decodeControl(encodeControl(msg))).toEqual(msg);
  });

  test('bundle-error round-trips', () => {
    const msg = { type: 'bundle-error', requestId: 7, hash: HASH_B, reason: 'unknown-hash' } as const;
    expect(decodeControl(encodeControl(msg))).toEqual(msg);
  });

  test('bundle-cancel round-trips', () => {
    const msg = { type: 'bundle-cancel', requestId: 99 } as const;
    expect(decodeControl(encodeControl(msg))).toEqual(msg);
  });

  test('decodeControl rejects invalid JSON', () => {
    expect(() => decodeControl('not json')).toThrow(BundleProtocolError);
  });

  test('decodeControl rejects unknown control type', () => {
    expect(() => decodeControl(JSON.stringify({ type: 'mystery', requestId: 1 })))
      .toThrow(/unknown control type/);
  });

  test('decodeControl rejects bad hash format', () => {
    expect(() => decodeControl(JSON.stringify({ type: 'bundle-request', requestId: 1, hash: 'short' })))
      .toThrow(/hash/);
  });

  test('decodeControl rejects bad requestId', () => {
    expect(() => decodeControl(JSON.stringify({ type: 'bundle-cancel', requestId: -1 })))
      .toThrow(/requestId/);
    expect(() => decodeControl(JSON.stringify({ type: 'bundle-cancel', requestId: 1.5 })))
      .toThrow(/requestId/);
  });
});

describe('BundleProtocol — binary frames', () => {
  test.each([
    ['1 byte',   1],
    ['1KB',      1024],
    ['16KB',     16 * 1024],
    ['64KB',     64 * 1024],
  ])('round-trips a %s payload', (_label, size) => {
    const payload = new Uint8Array(size).map((_, i) => i & 0xFF);
    const frame: BundleFrame = { requestId: 12345, seq: 7, lastChunk: true, payload };
    const decoded = decodeFrame(encodeFrame(frame));
    expect(decoded.requestId).toBe(12345);
    expect(decoded.seq).toBe(7);
    expect(decoded.lastChunk).toBe(true);
    expect(Array.from(decoded.payload)).toEqual(Array.from(payload));
  });

  test('lastChunk flag is preserved on both true and false', () => {
    const a = decodeFrame(encodeFrame({ requestId: 1, seq: 0, lastChunk: false, payload: new Uint8Array([1, 2, 3]) }));
    const b = decodeFrame(encodeFrame({ requestId: 1, seq: 1, lastChunk: true,  payload: new Uint8Array([4, 5, 6]) }));
    expect(a.lastChunk).toBe(false);
    expect(b.lastChunk).toBe(true);
  });

  test('decodeFrame rejects truncated input (< 9-byte header)', () => {
    expect(() => decodeFrame(new Uint8Array([1, 2, 3]))).toThrow(BundleProtocolError);
    expect(() => decodeFrame(new Uint8Array())).toThrow(BundleProtocolError);
  });

  test('encodeFrame rejects out-of-range requestId / seq', () => {
    const payload = new Uint8Array([1]);
    expect(() => encodeFrame({ requestId: -1, seq: 0, lastChunk: false, payload })).toThrow();
    expect(() => encodeFrame({ requestId: 0,  seq: 2 ** 33, lastChunk: false, payload })).toThrow();
  });

  test('frames carry independent requestIds for multiplexing', () => {
    const f1 = decodeFrame(encodeFrame({ requestId: 1, seq: 0, lastChunk: false, payload: new Uint8Array([0xAA]) }));
    const f2 = decodeFrame(encodeFrame({ requestId: 2, seq: 0, lastChunk: false, payload: new Uint8Array([0xBB]) }));
    expect(f1.requestId).toBe(1);
    expect(f2.requestId).toBe(2);
  });
});
