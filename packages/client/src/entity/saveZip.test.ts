import { describe, test, expect } from 'vitest';
import { encodeZip, decodeZip, looksLikeZip, SaveZipError } from './saveZip';

const enc = (s: string) => new TextEncoder().encode(s);

describe('looksLikeZip', () => {
  test('returns true for the output of encodeZip', async () => {
    const zip = await encodeZip(enc('{}'), []);
    expect(looksLikeZip(zip)).toBe(true);
  });

  test('returns false for raw JSON', () => {
    expect(looksLikeZip(enc('{"format":"vtt-scene"}'))).toBe(false);
  });

  test('returns false for arbitrary bytes', () => {
    expect(looksLikeZip(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBe(false);
  });

  test('returns false for truncated input', () => {
    expect(looksLikeZip(new Uint8Array([0x50, 0x4b]))).toBe(false);
    expect(looksLikeZip(new Uint8Array())).toBe(false);
  });
});

describe('encodeZip / decodeZip round-trip', () => {
  test('preserves envelope bytes exactly', async () => {
    const envelope = enc('{"format":"vtt-scene","version":2}');
    const zip      = await encodeZip(envelope, []);
    const { envelopeBytes, blobs } = await decodeZip(zip);
    expect(Array.from(envelopeBytes)).toEqual(Array.from(envelope));
    expect(blobs).toEqual([]);
  });

  test('preserves every blob byte-for-byte', async () => {
    const envelope = enc('{}');
    const b1 = { name: 'aa11', bytes: new Uint8Array([1, 2, 3, 4, 5]) };
    const b2 = { name: 'bb22', bytes: new Uint8Array(1024).map((_, i) => i & 0xff) };
    const zip = await encodeZip(envelope, [b1, b2]);
    const { blobs } = await decodeZip(zip);
    const byName = new Map(blobs.map(b => [b.name, b.bytes]));
    expect(Array.from(byName.get('aa11')!)).toEqual(Array.from(b1.bytes));
    expect(Array.from(byName.get('bb22')!)).toEqual(Array.from(b2.bytes));
  });

  test('zero-blob zip contains only scene.json and is valid', async () => {
    const envelope = enc('{}');
    const zip = await encodeZip(envelope, []);
    expect(looksLikeZip(zip)).toBe(true);
    const { blobs } = await decodeZip(zip);
    expect(blobs.length).toBe(0);
  });
});

describe('decodeZip errors', () => {
  test('rejects non-zip input', async () => {
    await expect(decodeZip(enc('{"not":"a zip"}'))).rejects.toBeInstanceOf(SaveZipError);
  });

  test('rejects truncated zip', async () => {
    const zip = await encodeZip(enc('{}'), []);
    await expect(decodeZip(zip.slice(0, 10))).rejects.toBeInstanceOf(SaveZipError);
  });

  test('rejects zip without scene.json', async () => {
    // Build a zip that has only `assets/x` and no scene.json — exercise the
    // missing-entry guard. Round-trip via fflate so we know it's structurally
    // a valid zip.
    const { zipSync } = await import('fflate');
    const bad = zipSync({ 'assets/x': new Uint8Array([1, 2, 3]) }, { level: 0 });
    await expect(decodeZip(bad)).rejects.toThrow(/scene\.json/);
  });
});

describe('decodeZip path normalisation', () => {
  test('treats backslash-separated paths from Windows tools as assets/<name>', async () => {
    // Simulate PowerShell Compress-Archive's backslash-separator behaviour.
    const { zipSync } = await import('fflate');
    const bytes = zipSync(
      { 'scene.json': enc('{}'), 'assets\\abc123': enc('hi') },
      { level: 0 },
    );
    const { blobs } = await decodeZip(bytes);
    expect(blobs.map(b => b.name)).toEqual(['abc123']);
  });
});

describe('encodeZip output is structurally a zip', () => {
  test('starts with the PK\\x03\\x04 local-file-header signature', async () => {
    const zip = await encodeZip(enc('{}'), [{ name: 'x', bytes: enc('hi') }]);
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
    expect(zip[2]).toBe(0x03);
    expect(zip[3]).toBe(0x04);
  });
});
