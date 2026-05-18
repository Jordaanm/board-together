// Per-peer bundled-asset transport over a single channel. Both host and
// guest construct an instance against the same underlying RTCDataChannel
// (or paired fake in tests); the same module plays either role depending
// on which methods get called:
//
//   - Host:  serve(hash, blob)         — register bytes available for pull.
//   - Guest: request(hash): Promise    — pull bytes by hash.
//
// All bytes flow through the same channel; binary frames carry a requestId
// header so concurrent transfers interleave naturally. Backpressure is
// applied above ~1MB of `bufferedAmount` and resumed on the
// `bufferedamountlow` event.

import { hashBlob } from './BundleHasher';
import {
  decodeControl,
  decodeFrame,
  encodeControl,
  encodeFrame,
  BundleProtocolError,
  type BundleFrame,
} from './BundleProtocol';

const CHUNK_BYTES                  = 16 * 1024;
const BACKPRESSURE_HIGH_WATER_MARK = 1   * 1024 * 1024; // 1MB
const BACKPRESSURE_LOW_WATER_MARK  = 256 * 1024;        // 256KB — drain target

// Subset of RTCDataChannel that BundleTransport relies on. The real channel
// and the in-memory paired fake both satisfy it.
export interface BundleChannel {
  send(data: string | ArrayBufferView | ArrayBuffer): void;
  bufferedAmount:             number;
  bufferedAmountLowThreshold: number;
  onmessage:           ((ev: { data: string | ArrayBuffer }) => void) | null;
  onbufferedamountlow: (() => void) | null;
}

export class BundleTransportError extends Error {
  constructor(message: string, readonly code: 'cancelled' | 'channel-closed' | 'unknown-hash' | 'hash-mismatch' | 'protocol' = 'protocol') {
    super(message);
  }
}

interface PendingRequest {
  hash:    string;
  chunks:  Uint8Array[];
  totalBytes: number;
  resolve: (blob: Blob) => void;
  reject:  (err: Error) => void;
}

export class BundleTransport {
  private readonly channel: BundleChannel;
  private nextRequestId = 1;
  private readonly pending          = new Map<number, PendingRequest>();
  private readonly served           = new Map<string, Blob>();
  private readonly cancelledServes  = new Set<number>();
  private readonly drainWaiters: Array<() => void> = [];
  private closed = false;

  constructor(channel: BundleChannel) {
    this.channel                            = channel;
    this.channel.bufferedAmountLowThreshold = BACKPRESSURE_LOW_WATER_MARK;
    this.channel.onmessage           = (ev) => this.handleMessage(ev.data);
    this.channel.onbufferedamountlow = ()   => this.drainBackpressure();
  }

  // Register `blob` as available for pull under `hash`. Idempotent.
  serve(hash: string, blob: Blob): void {
    this.served.set(hash, blob);
  }

  // Drop a previously-served mapping. In-flight transfers that already
  // started chunking are not interrupted — only future pulls will fail.
  unserve(hash: string): void {
    this.served.delete(hash);
  }

  // Issue a pull. Returns `{ promise, cancel }`. `cancel()` sends a
  // bundle-cancel and rejects the promise locally — pending chunks the
  // host has already queued may still arrive but are ignored by requestId
  // (the entry has been removed from `pending`).
  request(hash: string): { promise: Promise<Blob>; cancel: () => void } {
    const requestId = this.nextRequestId++;
    let resolveOuter!: (blob: Blob) => void;
    let rejectOuter!: (err: Error) => void;
    const promise = new Promise<Blob>((res, rej) => { resolveOuter = res; rejectOuter = rej; });

    this.pending.set(requestId, {
      hash,
      chunks:     [],
      totalBytes: 0,
      resolve:    resolveOuter,
      reject:     rejectOuter,
    });

    try {
      this.channel.send(encodeControl({ type: 'bundle-request', requestId, hash }));
    } catch (err) {
      this.pending.delete(requestId);
      rejectOuter(new BundleTransportError(`channel send failed: ${(err as Error).message}`, 'channel-closed'));
    }

    const cancel = () => {
      const p = this.pending.get(requestId);
      if (!p) return;
      this.pending.delete(requestId);
      try {
        this.channel.send(encodeControl({ type: 'bundle-cancel', requestId }));
      } catch {
        // Channel may already be closed — local rejection still proceeds.
      }
      p.reject(new BundleTransportError('cancelled', 'cancelled'));
    };

    return { promise, cancel };
  }

  // Reject every pending request and stop accepting messages. Used when the
  // underlying channel closes (peer disconnect).
  close(reason = 'channel closed'): void {
    this.closed = true;
    for (const [, p] of this.pending) {
      p.reject(new BundleTransportError(reason, 'channel-closed'));
    }
    this.pending.clear();
    // Wake anyone parked on backpressure so they can observe the close.
    this.drainBackpressure();
  }

  private handleMessage(data: string | ArrayBuffer): void {
    if (this.closed) return;
    if (typeof data === 'string') {
      try {
        const msg = decodeControl(data);
        if (msg.type === 'bundle-request') void this.handleRequest(msg.requestId, msg.hash);
        else if (msg.type === 'bundle-cancel') this.cancelledServes.add(msg.requestId);
        else if (msg.type === 'bundle-error')  this.handleError(msg.requestId, msg.reason);
      } catch (err) {
        // Protocol error on control message — drop it. A real channel
        // would carry a peer that's protocol-broken, which we can't
        // recover from at this layer.
        if (!(err instanceof BundleProtocolError)) throw err;
      }
      return;
    }
    try {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
      const frame = decodeFrame(bytes);
      void this.handleFrame(frame);
    } catch (err) {
      if (!(err instanceof BundleProtocolError)) throw err;
      // Malformed frame — caller-side, drop.
    }
  }

  private handleError(requestId: number, reason: string): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    const code = reason === 'unknown-hash' ? 'unknown-hash' : 'protocol';
    p.reject(new BundleTransportError(reason, code));
  }

  private async handleFrame(frame: BundleFrame): Promise<void> {
    const p = this.pending.get(frame.requestId);
    if (!p) return; // stale frame (cancelled / unknown id)
    p.chunks.push(frame.payload);
    p.totalBytes += frame.payload.length;
    if (!frame.lastChunk) return;
    this.pending.delete(frame.requestId);
    const blob       = new Blob(p.chunks);
    const actualHash = await hashBlob(blob);
    if (actualHash !== p.hash) {
      p.reject(new BundleTransportError(
        `hash mismatch: expected ${p.hash} got ${actualHash}`,
        'hash-mismatch',
      ));
      return;
    }
    p.resolve(blob);
  }

  private async handleRequest(requestId: number, hash: string): Promise<void> {
    const blob = this.served.get(hash);
    if (!blob) {
      try {
        this.channel.send(encodeControl({
          type: 'bundle-error', requestId, hash, reason: 'unknown-hash',
        }));
      } catch { /* channel gone, peer will time out */ }
      return;
    }
    const bytes  = new Uint8Array(await blob.arrayBuffer());
    let seq = 0;
    let off = 0;
    do {
      if (this.cancelledServes.has(requestId) || this.closed) {
        this.cancelledServes.delete(requestId);
        return;
      }
      const end       = Math.min(off + CHUNK_BYTES, bytes.length);
      const payload   = bytes.slice(off, end);
      const lastChunk = end >= bytes.length;
      const frame     = encodeFrame({ requestId, seq, lastChunk, payload });
      await this.sendWithBackpressure(frame);
      seq++;
      off = end;
      if (lastChunk) return;
    } while (off < bytes.length);
  }

  private async sendWithBackpressure(data: Uint8Array): Promise<void> {
    if (this.closed) return;
    if (this.channel.bufferedAmount > BACKPRESSURE_HIGH_WATER_MARK) {
      await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
      if (this.closed) return;
    }
    try { this.channel.send(data); }
    catch {
      this.closed = true;
      this.drainBackpressure();
    }
  }

  private drainBackpressure(): void {
    const waiters = this.drainWaiters.splice(0);
    for (const w of waiters) w();
  }
}
