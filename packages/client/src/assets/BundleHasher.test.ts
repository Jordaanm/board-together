import { describe, test, expect } from 'vitest';
import { hashBlob, hashBytes } from './BundleHasher';

// Known SHA-256 fixtures, cross-checked against `openssl sha256`.
const EMPTY_SHA256       = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ABC_SHA256         = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const HELLO_WORLD_SHA256 = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';

describe('hashBlob', () => {
  test('empty Blob hashes to canonical empty-SHA-256', async () => {
    expect(await hashBlob(new Blob([]))).toBe(EMPTY_SHA256);
  });

  test('"abc" hashes to known value', async () => {
    expect(await hashBlob(new Blob(['abc']))).toBe(ABC_SHA256);
  });

  test('"hello world" hashes to known value', async () => {
    expect(await hashBlob(new Blob(['hello world']))).toBe(HELLO_WORLD_SHA256);
  });

  test('hex output is lowercase 64-char string', async () => {
    const hex = await hashBlob(new Blob(['anything']));
    expect(hex).toMatch(/^[a-f0-9]{64}$/);
  });

  test('identical bytes hash equal across Blob constructions', async () => {
    const a = await hashBlob(new Blob([new Uint8Array([1, 2, 3, 4])]));
    const b = await hashBlob(new Blob([Uint8Array.from([1, 2, 3, 4])]));
    expect(a).toBe(b);
  });
});

describe('hashBytes', () => {
  test('matches hashBlob for the same input bytes', async () => {
    const bytes = new TextEncoder().encode('hello world');
    expect(await hashBytes(bytes)).toBe(HELLO_WORLD_SHA256);
    expect(await hashBytes(bytes.buffer)).toBe(HELLO_WORLD_SHA256);
  });
});
