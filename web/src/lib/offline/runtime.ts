import { apiFetch, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { isNativeApp, nativeSessionBlocked } from "@/lib/mobile/config";
import { OfflineEngine, replaceIds } from "./engine";
import { nativeOfflineStore, nativeStorage } from "./storage";
import type { OfflineOperation } from "./types";

export const offline: OfflineEngine = new OfflineEngine(nativeStorage, {
  request: (body) => client.requestOnline(body),
  operation: (op, request) => apiFetch(`/api/offline/jmap/${encodeURIComponent(op.id)}`, {
    method: "POST", body: JSON.stringify({ request, base: replaceIds(op.base, offline.manifest?.mappings ?? {}) }),
  }),
  blob: (accountId, blobId, type) => client.fetchBlobOnline(accountId, blobId, type),
  upload: (accountId, blob) => client.uploadOnline(accountId, blob),
});
let timer: number | null = null;
let wired = false;
let active = true;
let ready = false;
export const offlineEnabled = () => isNativeApp() && Boolean(offline.manifest);
export async function prepareOffline(session: JmapSession): Promise<void> {
  if (!isNativeApp() || !session.ihasmail?.remember) return;
  await offline.activate(session);
  if (!offline.manifest) return;
  await nativeOfflineStore.configure({ scope: offline.scope, accountId: offline.manifest.accountId, active });
  client.offline = offline;
  ready = true;
  wire();
}
export async function restoreOffline(): Promise<JmapSession | null> {
  if (!isNativeApp() || nativeSessionBlocked()) return null;
  const session = await offline.restore();
  if (session) { client.offline = offline; await nativeOfflineStore.configure({ scope: offline.scope, accountId: offline.manifest!.accountId, active }); await offline.reload(); ready = true; wire(); }
  return session;
}
export function startOfflineSync(): void {
  if (!ready || !active || !offlineEnabled()) return;
  void offline.sync().then(() => window.dispatchEvent(new CustomEvent("webmail:offline-updated")));
}
function wire() {
  if (timer === null) timer = window.setInterval(() => { if (active) startOfflineSync(); }, 30_000);
  if (wired) return;
  wired = true;
  window.addEventListener("online", startOfflineSync);
  window.addEventListener("offline", () => { offline.pause(); offline.setOnline(false); });
  window.addEventListener("webmail:app-state", (event) => {
    active = Boolean((event as CustomEvent<boolean>).detail);
    if (!ready || !offline.manifest) return;
    if (!active) offline.pause();
    void nativeOfflineStore.configure({ scope: offline.scope, accountId: offline.manifest.accountId, active }).then(async () => {
      if (active) {
        const profile = JSON.parse(await nativeStorage.read("profile", "active") ?? "null") as { expired?: boolean } | null;
        if (profile?.expired) { client.handleUnauthenticated(); return; }
        await offline.reload(); window.dispatchEvent(new CustomEvent("webmail:offline-updated")); startOfflineSync();
      }
    }).catch(() => undefined);
  });
}
export async function stopOffline(clear = false): Promise<void> {
  if (!isNativeApp()) return;
  ready = false;
  offline.pause();
  client.offline = null;
  if (timer !== null) { window.clearInterval(timer); timer = null; }
  // Native clear stops jobs and destroys encryption keys before sign-out completes.
  if (clear) await offline.clear();
  else if (offline.manifest) await nativeOfflineStore.configure({ scope: offline.scope, accountId: offline.manifest.accountId, active: true });
}
export function pendingOperations(): OfflineOperation[] { return offline.manifest?.operations ?? []; }

export async function bindOfflineNotifications(binding: string): Promise<void> {
  if (ready && offline.manifest) await nativeOfflineStore.configure({ scope: offline.scope, accountId: offline.manifest.accountId, active, binding });
}
