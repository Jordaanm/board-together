// Single source of truth for hashing bundled asset bytes. SHA-256, hex-encoded.
// Wraps crypto.subtle.digest so callers never re-derive the algorithm choice
// or the hex format — both are fixed by the on-disk save layout and the wire
// protocol (see prd--asset-blobs.md).

export async function hashBlob(blob: Blob): Promise<string> {
  const buf    = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return toHex(new Uint8Array(digest));
}

export async function hashBytes(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const data   = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}
