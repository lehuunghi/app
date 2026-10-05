import { registerPlugin } from "@capacitor/core";
import type { OfflineStorage, StoreChange } from "./types";

export interface OfflineStorePlugin {
  read(options: { scope: string; key: string }): Promise<{ value: string | null }>;
  list(options: { scope: string; prefix: string }): Promise<{ values: Record<string, string> }>;
  commit(options: { scope: string; changes: StoreChange[] }): Promise<void>;
  clear(): Promise<void>;
  bytes(options: { scope: string }): Promise<{ bytes: number }>;
  configure(options: { scope: string; accountId: string; active: boolean; binding?: string }): Promise<void>;
  sync(): Promise<void>;
}
export const nativeOfflineStore = registerPlugin<OfflineStorePlugin>("OfflineMailStore");
export const nativeStorage: OfflineStorage = {
  read: async (scope, key) => (await nativeOfflineStore.read({ scope, key })).value,
  list: async (scope, prefix) => (await nativeOfflineStore.list({ scope, prefix })).values,
  commit: (scope, changes) => nativeOfflineStore.commit({ scope, changes }),
  clear: () => nativeOfflineStore.clear(),
  bytes: async (scope) => (await nativeOfflineStore.bytes({ scope })).bytes,
};

/** Test adapter deliberately injectable: production never falls back to RAM. */
export class MemoryOfflineStorage implements OfflineStorage {
  private rows = new Map<string, string>();
  async read(scope: string, key: string) { return this.rows.get(`${scope}\0${key}`) ?? null; }
  async list(scope: string, prefix: string) {
    const values: Record<string, string> = {};
    for (const [key, value] of this.rows) if (key.startsWith(`${scope}\0${prefix}`)) values[key.slice(scope.length + 1)] = value;
    return values;
  }
  async commit(scope: string, changes: StoreChange[]) {
    for (const { key, value } of changes) {
      if (value == null) this.rows.delete(`${scope}\0${key}`);
      else this.rows.set(`${scope}\0${key}`, value);
    }
  }
  async clear() { this.rows.clear(); }
  async bytes(scope: string) { return Object.values(await this.list(scope, "")).reduce((n, s) => n + new TextEncoder().encode(s).length, 0); }
}
