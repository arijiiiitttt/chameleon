import type { SensitivityType } from "@chameleon/shared-types";

export interface VaultStorageAdapter {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  clear(): Promise<void>;
}

/** In-memory adapter - used in Node tests/benchmarks and as a same-tab fallback. Never persists across sessions. */
export class InMemoryVaultAdapter implements VaultStorageAdapter {
  private map = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.map.get(key);
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async clear(): Promise<void> {
    this.map.clear();
  }
}

/**
 * IndexedDB-backed adapter for use inside the extension's content-script /
 * background context. Kept isolated behind the same VaultStorageAdapter
 * interface so it can be swapped out in tests without a DOM.
 */
export class IndexedDbVaultAdapter implements VaultStorageAdapter {
  private dbPromise: Promise<IDBDatabase>;
  private static readonly DB_NAME = "chameleon-vault";
  private static readonly STORE = "tokens";

  constructor() {
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(IndexedDbVaultAdapter.DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(IndexedDbVaultAdapter.STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async get(key: string): Promise<string | undefined> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IndexedDbVaultAdapter.STORE, "readonly");
      const req = tx.objectStore(IndexedDbVaultAdapter.STORE).get(key);
      req.onsuccess = () => resolve(req.result as string | undefined);
      req.onerror = () => reject(req.error);
    });
  }

  async set(key: string, value: string): Promise<void> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IndexedDbVaultAdapter.STORE, "readwrite");
      tx.objectStore(IndexedDbVaultAdapter.STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async clear(): Promise<void> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IndexedDbVaultAdapter.STORE, "readwrite");
      tx.objectStore(IndexedDbVaultAdapter.STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

/**
 * PrivacyVault: the ONLY place raw sensitive values are ever stored.
 * INVARIANT (spec section 19, 82-INVARIANT-4): nothing in this class may be
 * logged, serialized into telemetry, or included in any object that is
 * passed to the firewall/network layer. Tokens (e.g. "EMAIL_1") are the
 * only thing allowed to leave this module's boundary.
 */
export class PrivacyVault {
  private counters = new Map<SensitivityType, number>();

  constructor(private adapter: VaultStorageAdapter) {}

  /** Registers a raw value and returns a fresh token for it. The raw value itself is returned to nobody. */
  async tokenize(category: SensitivityType, rawValue: string): Promise<string> {
    const next = (this.counters.get(category) ?? 0) + 1;
    this.counters.set(category, next);
    const token = `${category}_${next}`;
    await this.adapter.set(token, rawValue);
    return token;
  }

  /** Resolves a token back to its raw value. Must only ever be called from the local action executor, never serialized outward. */
  async resolve(token: string): Promise<string | undefined> {
    return this.adapter.get(token);
  }

  async reset(): Promise<void> {
    this.counters.clear();
    await this.adapter.clear();
  }
}
