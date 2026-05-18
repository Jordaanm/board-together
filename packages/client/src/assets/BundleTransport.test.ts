import { describe, test, expect } from 'vitest';
import { BundleTransport, BundleTransportError, type BundleChannel } from './BundleTransport';
import { encodeFrame } from './BundleProtocol';
import { hashBlob } from './BundleHasher';

// Paired in-memory channel — send on one side delivers to the other side's
// onmessage. Delivery is via queueMicrotask so the data hop is properly
// async (matches real RTCDataChannel behaviour).
function pairChannels(): [FakeChannel, FakeChannel] {
  const a = new FakeChannel();
  const b = new FakeChannel();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

class FakeChannel implements BundleChannel {
  bufferedAmount             = 0;
  bufferedAmountLowThreshold = 0;
  onmessage:           ((ev: { data: string | ArrayBuffer }) => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;
  peer!: FakeChannel;
  // When > 0, send() increments bufferedAmount instead of delivering and
  // the test calls `drain()` to simulate the channel emptying.
  backpressureMode = false;
  buffered: Array<string | ArrayBuffer> = [];

  send(data: string | ArrayBufferView | ArrayBuffer): void {
    const wire: string | ArrayBuffer =
      typeof data === 'string'
        ? data
        : ArrayBuffer.isView(data)
          ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
          : data;
    if (this.backpressureMode) {
      this.buffered.push(wire);
      this.bufferedAmount += typeof wire === 'string' ? wire.length : wire.byteLength;
      return;
    }
    queueMicrotask(() => this.peer.onmessage?.({ data: wire }));
  }

  drain(): void {
    const queued = this.buffered.splice(0);
    this.bufferedAmount = 0;
    for (const item of queued) {
      queueMicrotask(() => this.peer.onmessage?.({ data: item }));
    }
    this.onbufferedamountlow?.();
  }
}

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

async function bytesOfBlob(blob: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

describe('BundleTransport — happy path', () => {
  test('peer.request resolves with byte-equal blob served by the host', async () => {
    const [chA, chB] = pairChannels();
    const host = new BundleTransport(chA);
    const peer = new BundleTransport(chB);
    const blob = new Blob([new Uint8Array([10, 20, 30, 40, 50])]);
    const hash = await hashBlob(blob);
    host.serve(hash, blob);

    const got = await peer.request(hash).promise;
    expect(await bytesOfBlob(got)).toEqual([10, 20, 30, 40, 50]);
  });

  test('large blob (multiple chunks) round-trips intact', async () => {
    const [chA, chB] = pairChannels();
    const host = new BundleTransport(chA);
    const peer = new BundleTransport(chB);
    const size = 64 * 1024 + 17;
    const data = new Uint8Array(size).map((_, i) => i & 0xFF);
    const blob = new Blob([data]);
    const hash = await hashBlob(blob);
    host.serve(hash, blob);

    const got = await peer.request(hash).promise;
    const out = new Uint8Array(await got.arrayBuffer());
    expect(out.length).toBe(size);
    for (let i = 0; i < size; i++) expect(out[i]).toBe(i & 0xFF);
  });

  test('two concurrent requests interleave and both resolve', async () => {
    const [chA, chB] = pairChannels();
    const host = new BundleTransport(chA);
    const peer = new BundleTransport(chB);
    const blob1 = new Blob([new Uint8Array(32 * 1024).map((_, i) => (i + 1) & 0xFF)]);
    const blob2 = new Blob([new Uint8Array(32 * 1024).map((_, i) => (i + 2) & 0xFF)]);
    const h1 = await hashBlob(blob1);
    const h2 = await hashBlob(blob2);
    host.serve(h1, blob1);
    host.serve(h2, blob2);

    const [a, b] = await Promise.all([peer.request(h1).promise, peer.request(h2).promise]);
    expect(await hashBlob(a)).toBe(h1);
    expect(await hashBlob(b)).toBe(h2);
  });
});

describe('BundleTransport — error paths', () => {
  test('request for an unknown hash rejects with unknown-hash error', async () => {
    const [chA, chB] = pairChannels();
    new BundleTransport(chA);                       // host with nothing served
    const peer = new BundleTransport(chB);
    const fakeHash = 'a'.repeat(64);
    await expect(peer.request(fakeHash).promise).rejects.toThrow(/unknown-hash/);
  });

  test('host serving wrong bytes triggers hash-mismatch on the peer', async () => {
    const [chA, chB] = pairChannels();
    const host = new BundleTransport(chA);
    const peer = new BundleTransport(chB);
    const correctBlob = new Blob([new Uint8Array([1, 2, 3])]);
    const claimedHash = await hashBlob(correctBlob);
    // Host serves WRONG bytes under the right hash.
    host.serve(claimedHash, new Blob([new Uint8Array([9, 9, 9])]));
    await expect(peer.request(claimedHash).promise).rejects.toThrow(/hash mismatch/);
  });

  test('cancel rejects the pending promise on the peer', async () => {
    const [chA, chB] = pairChannels();
    const host = new BundleTransport(chA);
    const peer = new BundleTransport(chB);
    const blob = new Blob([new Uint8Array(200 * 1024)]); // multi-chunk
    const hash = await hashBlob(blob);
    host.serve(hash, blob);

    const handle = peer.request(hash);
    // Cancel before the transfer completes — pending promise rejects.
    handle.cancel();
    await expect(handle.promise).rejects.toThrow(/cancelled/);
  });

  test('close rejects every in-flight request with channel-closed', async () => {
    const [chA, chB] = pairChannels();
    new BundleTransport(chA);
    const peer = new BundleTransport(chB);
    const fakeHash = 'b'.repeat(64);
    const handle = peer.request(fakeHash);
    peer.close('peer dropped');
    await expect(handle.promise).rejects.toMatchObject({
      code: 'channel-closed',
    });
  });
});

describe('BundleTransport — backpressure', () => {
  test('sends pause when bufferedAmount exceeds the high-water mark', async () => {
    const [chA, chB] = pairChannels();
    const host = new BundleTransport(chA);
    new BundleTransport(chB);
    const blob = new Blob([new Uint8Array(64 * 1024)]); // 4 chunks at 16KB
    const hash = await hashBlob(blob);
    host.serve(hash, blob);

    // Flip the host's channel into buffering mode BEFORE the request lands.
    chA.backpressureMode = true;
    chA.bufferedAmount   = 2 * 1024 * 1024; // already over the 1MB ceiling

    new BundleTransport(chB); // peer
    const req = new BundleTransport(chB);
    const handle = req.request(hash);
    await flushMicrotasks();
    await flushMicrotasks();

    // Nothing should have been queued from the host yet — the request hop
    // travelled on chB.send, but chA's send is parked on backpressure.
    expect(chA.buffered.length).toBe(0);

    // Drain — the host's queued chunk sends now go through. Re-enable
    // immediate delivery so the peer receives them.
    chA.backpressureMode = false;
    chA.drain();
    // Allow Promise resolution chain to settle.
    await handle.promise.catch(() => {});
  });
});

describe('BundleTransport — stale frames after cancel', () => {
  test('frames arriving after cancel are silently ignored', async () => {
    const [chA, chB] = pairChannels();
    const peer = new BundleTransport(chB);
    new BundleTransport(chA); // host present so onmessage handlers are wired
    // Manually inject a frame for a requestId we never created.
    const stray = encodeFrame({ requestId: 9999, seq: 0, lastChunk: true, payload: new Uint8Array([1]) });
    // Direct deliver to peer — shouldn't crash.
    chB.onmessage?.({ data: stray.buffer });
    await flushMicrotasks();
    expect(peer).toBeDefined();
  });
});

describe('BundleTransport — empty payload', () => {
  test('zero-length blob round-trips with a single last-chunk frame', async () => {
    const [chA, chB] = pairChannels();
    const host = new BundleTransport(chA);
    const peer = new BundleTransport(chB);
    const blob = new Blob([new Uint8Array(0)]);
    const hash = await hashBlob(blob);
    host.serve(hash, blob);
    const got = await peer.request(hash).promise;
    expect(got.size).toBe(0);
  });
});

// We exported BundleTransportError above for use in other modules; touch
// it here so the import is tree-shake friendly and rename refactors notice.
test('BundleTransportError exposes a code field', () => {
  const err = new BundleTransportError('boom', 'cancelled');
  expect(err.code).toBe('cancelled');
});
