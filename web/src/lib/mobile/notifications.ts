import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import { LocalNotifications } from "@capacitor/local-notifications";
import { apiFetch, client } from "@/jmap/client";
import { useSession } from "@/store/session";
import { isNativeApp, nativeSessionBlocked, ANDROID_PUSH_CONFIGURED } from "./config";
import { withBase } from "@/lib/basePath";
import { t } from "@/lib/i18n";

const PREF = "webmail:native-notifications";
const DEVICE = "webmail:notification-installation";
const CHANNEL = "webmail-new-mail";
export interface NativeNotificationState {
  enabled: boolean;
  permission: "granted" | "denied" | "default";
  phase: "idle" | "connecting" | "connected" | "unavailable" | "failed";
}
let state: NativeNotificationState = { enabled: true, permission: "default", phase: "idle" };
const subscribers = new Set<() => void>();
export const notificationSnapshot = () => state;
export function subscribeNotifications(fn: () => void) { subscribers.add(fn); return () => { subscribers.delete(fn); }; }
function publish(next: Partial<NativeNotificationState>) {
  state = { ...state, ...next };
  for (const fn of subscribers) fn();
}
let generation = 0;
let initialized: Promise<void> | undefined;
let connecting: Promise<void> | undefined;
let binding = "";
let pendingTap: string | undefined;
let pushToken = "";
let notificationId = 100;
let tokenWaiter: { resolve: () => void; reject: () => void } | undefined;
function installation(): string {
  let value = localStorage.getItem(DEVICE);
  if (!value) { value = crypto.randomUUID(); localStorage.setItem(DEVICE, value); }
  return value;
}
const platform = () => Capacitor.getPlatform() as "android" | "ios";
const endpoint = () => `/api/notifications/native?installation=${encodeURIComponent(installation())}&platform=${platform()}`;
const authenticated = () => useSession.getState().status === "authenticated" && !nativeSessionBlocked();
function openInbox(tapBinding: string) {
  if (!authenticated()) { pendingTap = tapBinding; return; }
  if (!binding) { pendingTap = tapBinding; return; }
  pendingTap = undefined;
  if (tapBinding !== binding) return;
  // Notification payloads never supply arbitrary URLs or select another account.
  void import("@/store/mail").then(({ useMail }) => {
    if (!authenticated() || tapBinding !== binding) return;
    const inbox = useMail.getState().roleId("inbox");
    const path = inbox ? `/mail/${encodeURIComponent(inbox)}` : "/mail";
    window.history.pushState({}, "", withBase(path));
    window.dispatchEvent(new PopStateEvent("popstate"));
    void useMail.getState().loadMailboxes();
  });
}

export function initializeNativeNotifications(): Promise<void> {
  if (!isNativeApp()) return Promise.resolve();
  return initialized ??= (async () => {
    publish({ enabled: localStorage.getItem(PREF) !== "off" });
    const handles: PluginListenerHandle[] = [];
    try {
      handles.push(await PushNotifications.addListener("registration", ({ value }) => {
        if (!authenticated() || !state.enabled) return;
        pushToken = value;
        tokenWaiter?.resolve();
        if (!tokenWaiter && state.phase === "connected") void registerToken(generation);
      }));
      handles.push(await PushNotifications.addListener("registrationError", () => {
        tokenWaiter?.reject();
        if (authenticated() && state.enabled) publish({ phase: "failed" });
      }));
      handles.push(await PushNotifications.addListener("pushNotificationActionPerformed", ({ notification }) => {
        if (typeof notification.data?.binding === "string") openInbox(notification.data.binding);
      }));
      handles.push(await PushNotifications.addListener("pushNotificationReceived", ({ data }) => {
        if (authenticated() && state.enabled && data?.binding === binding) { void showNativeNotification(false, true); void import("@/lib/offline/runtime").then((o) => o.startOfflineSync()); }
      }));
      handles.push(await LocalNotifications.addListener("localNotificationActionPerformed", ({ notification }) => {
        if (typeof notification.extra?.binding === "string") openInbox(notification.extra.binding);
      }));
      if (platform() === "android") await LocalNotifications.createChannel({ id: CHANNEL, name: t("New mail"), importance: 4, visibility: 0, vibration: true });
      window.addEventListener("webmail:app-state", (event) => {
        if ((event as CustomEvent<boolean>).detail && authenticated() && state.enabled) void startNativeNotifications(false);
      });
    } catch (err) {
      await Promise.allSettled(handles.map((h) => h.remove()));
      throw err;
    }
  })().catch((err) => { initialized = undefined; throw err; });
}

export async function nativeNotificationPermission(prompt = false): Promise<NotificationPermission> {
  let result = await LocalNotifications.checkPermissions();
  if (prompt && ["prompt", "prompt-with-rationale"].includes(result.display)) result = await LocalNotifications.requestPermissions();
  const permission = result.display === "granted" ? "granted" : result.display === "denied" ? "denied" : "default";
  publish({ permission });
  return permission;
}
async function registerToken(epoch: number) {
  if (!pushToken || !authenticated() || !state.enabled || epoch !== generation) return;
  try {
    const result = await apiFetch<{ binding: string }>("/api/notifications/native", {
      method: "POST", body: JSON.stringify({ installation: installation(), platform: platform(), token: pushToken, offlineSync: Boolean(client.offline?.manifest) }),
    }, { handleUnauthenticated: false });
    if (!authenticated() || !state.enabled || epoch !== generation) {
      // Disable/logout may have happened while the POST was in flight.
      if (!authenticated() || !state.enabled) await removeRegistration();
      return;
    }
    binding = result.binding;
    void import("@/lib/offline/runtime").then((o) => o.bindOfflineNotifications(binding)).catch(() => undefined);
    publish({ phase: "connected" });
    if (pendingTap) openInbox(pendingTap);
  } catch { if (epoch === generation && authenticated()) publish({ phase: "failed" }); }
}
export function startNativeNotifications(prompt = true): Promise<void> {
  if (!isNativeApp()) return Promise.resolve();
  if (connecting) return connecting;
  const epoch = generation;
  const work = (async () => {
    await initializeNativeNotifications();
    if (epoch !== generation || !state.enabled || !authenticated()) return;
    if (await nativeNotificationPermission(prompt) !== "granted") return;
    if (epoch !== generation || !authenticated()) return;
    publish({ phase: "connecting" });
    try {
      const server = await apiFetch<{ ready: boolean; binding: string }>(endpoint(), {}, { handleUnauthenticated: false });
      if (epoch !== generation || !authenticated()) return;
      binding = server.binding;
      if (pendingTap) openInbox(pendingTap);
      if (!server.ready || (platform() === "android" && !ANDROID_PUSH_CONFIGURED)) { publish({ phase: "unavailable" }); return; }
      await PushNotifications.requestPermissions();
      if (platform() === "android") await PushNotifications.createChannel({ id: CHANNEL, name: t("New mail"), importance: 4, visibility: 0, vibration: true });
      let waiter: NonNullable<typeof tokenWaiter>;
      const registered = new Promise<void>((resolve, reject) => {
        waiter = { resolve, reject: () => reject(new Error("registration_failed")) };
        tokenWaiter = waiter;
      });
      // Attach a handler immediately; a registration error may arrive before
      // register() resolves on the native bridge.
      void registered.catch(() => undefined);
      const timer = window.setTimeout(() => waiter.reject(), 15_000);
      try { await PushNotifications.register(); await registered; }
      finally { window.clearTimeout(timer); if (tokenWaiter === waiter!) tokenWaiter = undefined; }
      await registerToken(epoch);
    } catch { if (epoch === generation && authenticated()) publish({ phase: "unavailable" }); }
  })().finally(() => { if (connecting === work) connecting = undefined; });
  connecting = work;
  return work;
}

/** Invalidate callbacks before touching network/native APIs. */
export async function stopNativeNotifications(): Promise<void> {
  if (!isNativeApp()) return;
  generation++; binding = ""; pendingTap = undefined; pushToken = ""; connecting = undefined;
  tokenWaiter?.reject(); tokenWaiter = undefined;
  publish({ phase: "idle" });
  await Promise.allSettled([
    removeRegistration(),
    platform() !== "android" || ANDROID_PUSH_CONFIGURED ? PushNotifications.unregister() : Promise.resolve(),
    PushNotifications.removeAllDeliveredNotifications(),
    LocalNotifications.cancelAll(), LocalNotifications.removeAllDeliveredNotifications(),
  ]);
}
async function removeRegistration(): Promise<void> {
  // Logout/expiration must never use apiFetch's 401 handler recursively.
  await fetch(withBase(endpoint()), { method: "DELETE", credentials: "include", headers: { "x-requested-with": "ihasmail" }, signal: AbortSignal.timeout(3000) }).catch(() => undefined);
}
export async function setNativeNotificationsEnabled(enabled: boolean): Promise<void> {
  localStorage.setItem(PREF, enabled ? "on" : "off");
  publish({ enabled });
  if (enabled) await startNativeNotifications(true);
  else await stopNativeNotifications();
}
export async function showNativeNotification(test = false, fromPush = false): Promise<void> {
  if (!isNativeApp() || !authenticated() || !state.enabled) return;
  if (!test && state.phase === "connected" && !fromPush) return;
  const epoch = generation;
  if (await nativeNotificationPermission(test) !== "granted" || epoch !== generation || !authenticated() || !state.enabled) return;
  await LocalNotifications.schedule({ notifications: [{ id: ++notificationId,
    title: test ? t("Test notification") : "Webmail",
    body: test ? t("This is what a new-mail notification looks like.") : t("You have new mail."),
    channelId: CHANNEL, smallIcon: "ic_notification", extra: { binding },
  }] });
}
