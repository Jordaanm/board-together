// Wire codec for bundled-asset transfer over a single RTCDataChannel.
//
// Two payload types share the channel:
//   - Control messages — JSON strings encoding bundle-request / -error /
//     -cancel. Sent and received as text frames.
//   - Binary frames — chunks of asset bytes prefixed with a fixed-size
//     header so the receiver can demultiplex multiple in-flight transfers
//     and detect end-of-stream:
//        [u32 requestId][u32 seq][u8 flags][payload]
//     Little-endian throughout. `flags & 1` set on the final chunk.
//
// Encoders/decoders are pure functions so the wire format can be unit
// tested without a live channel. BundleTransport (sibling module) owns the
// state machine.

export interface BundleRequestMessage {
  type:      'bundle-request';
  requestId: number;
  hash:      string;
}

export interface BundleErrorMessage {
  type:      'bundle-error';
  requestId: number;
  hash:      string;
  reason:    string;
}

export interface BundleCancelMessage {
  type:      'bundle-cancel';
  requestId: number;
}

export type BundleControlMessage =
  | BundleRequestMessage
  | BundleErrorMessage
  | BundleCancelMessage;

export class BundleProtocolError extends Error {}

const HEADER_BYTES = 9; // u32 + u32 + u8
const FLAG_LAST    = 0x01;

const HASH_RE = /^[a-f0-9]{64}$/;

export function encodeControl(msg: BundleControlMessage): string {
  return JSON.stringify(msg);
}

export function decodeControl(text: string): BundleControlMessage {
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { throw new BundleProtocolError('control message is not valid JSON'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BundleProtocolError('control message must be an object');
  }
  const m = raw as Record<string, unknown>;
  if (m.type === 'bundle-request') {
    requireUint32(m.requestId, 'requestId');
    requireHash(m.hash, 'hash');
    return { type: 'bundle-request', requestId: m.requestId as number, hash: m.hash as string };
  }
  if (m.type === 'bundle-error') {
    requireUint32(m.requestId, 'requestId');
    requireHash(m.hash, 'hash');
    if (typeof m.reason !== 'string') throw new BundleProtocolError('reason must be a string');
    return { type: 'bundle-error', requestId: m.requestId as number, hash: m.hash as string, reason: m.reason };
  }
  if (m.type === 'bundle-cancel') {
    requireUint32(m.requestId, 'requestId');
    return { type: 'bundle-cancel', requestId: m.requestId as number };
  }
  throw new BundleProtocolError(`unknown control type: ${JSON.stringify(m.type)}`);
}

export interface BundleFrame {
  requestId: number;
  seq:       number;
  lastChunk: boolean;
  payload:   Uint8Array;
}

export function encodeFrame(frame: BundleFrame): Uint8Array {
  if (!Number.isInteger(frame.requestId) || frame.requestId < 0 || frame.requestId > 0xFFFFFFFF) {
    throw new BundleProtocolError(`requestId out of range: ${frame.requestId}`);
  }
  if (!Number.isInteger(frame.seq) || frame.seq < 0 || frame.seq > 0xFFFFFFFF) {
    throw new BundleProtocolError(`seq out of range: ${frame.seq}`);
  }
  const out = new Uint8Array(HEADER_BYTES + frame.payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, frame.requestId, true);
  view.setUint32(4, frame.seq,       true);
  view.setUint8(8, frame.lastChunk ? FLAG_LAST : 0);
  out.set(frame.payload, HEADER_BYTES);
  return out;
}

export function decodeFrame(bytes: Uint8Array): BundleFrame {
  if (bytes.length < HEADER_BYTES) {
    throw new BundleProtocolError(`frame truncated: ${bytes.length} bytes (< header ${HEADER_BYTES})`);
  }
  const view      = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const requestId = view.getUint32(0, true);
  const seq       = view.getUint32(4, true);
  const flags     = view.getUint8(8);
  const lastChunk = (flags & FLAG_LAST) !== 0;
  const payload   = bytes.slice(HEADER_BYTES);
  return { requestId, seq, lastChunk, payload };
}

function requireUint32(v: unknown, field: string): void {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 0xFFFFFFFF) {
    throw new BundleProtocolError(`${field} must be a u32`);
  }
}

function requireHash(v: unknown, field: string): void {
  if (typeof v !== 'string' || !HASH_RE.test(v)) {
    throw new BundleProtocolError(`${field} must be 64 lowercase hex chars`);
  }
}
