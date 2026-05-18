// Real-IDB persistence layer for BundleCache. Single object store keyed by
// `hash`, with one `lastAccessed` index used for LRU scans during eviction.
// Not unit-tested at this layer — the cache test suite uses an in-memory
// driver; IDB behaviour is exercised in integration (#7) and the
// end-to-end smoke (#12).

import type { BundleCacheDriver, BundleCacheRecord } from './BundleCache';

const STORE_NAME       = 'bundle-blobs';
const LAST_ACCESS_INDEX = 'by-lastAccessed';

export class IdbBundleCacheDriver implements BundleCacheDriver {
  private readonly dbPromise: Promise<IDBDatabase>;

  constructor(dbName = 'board-together-bundles', version = 1) {
    this.dbPromise = openDb(dbName, version);
  }

  async get(hash: string): Promise<BundleCacheRecord | undefined> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(hash);
      req.onsuccess = () => resolve(req.result as BundleCacheRecord | undefined);
      req.onerror   = () => reject(req.error);
    });
  }

  async put(record: BundleCacheRecord): Promise<void> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put(record);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  async delete(hash: string): Promise<void> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).delete(hash);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  async list(opts: { pinned?: boolean } = {}): Promise<BundleCacheRecord[]> {
    const db = await this.dbPromise;
    const all: BundleCacheRecord[] = await new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result as BundleCacheRecord[]);
      req.onerror   = () => reject(req.error);
    });
    return opts.pinned === undefined ? all : all.filter(r => r.pinned === opts.pinned);
  }
}

function openDb(name: string, version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'hash' });
        store.createIndex(LAST_ACCESS_INDEX, 'lastAccessed', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}
