import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  current: { status: "authenticated", session: { ihasmail: { sessionId: "one" } } },
  platform: "android", api: vi.fn(), schedule: vi.fn(), register: vi.fn(), unregister: vi.fn(),
  permission: vi.fn(), listeners: {} as Record<string, (v: any) => void>,
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => h.platform, isNativePlatform: () => true } }));
vi.mock("@/jmap/client", () => ({ apiFetch: h.api }));
vi.mock("@/store/session", () => ({ useSession: { getState: () => h.current } }));
vi.mock("@/store/mail", () => ({ useMail: { getState: () => ({ roleId: () => "inbox", loadMailboxes: async () => {} }) } }));
vi.mock("@capacitor/push-notifications", () => ({ PushNotifications: {
  addListener: async (name: string, fn: (v: any) => void) => { h.listeners[name] = fn; return { remove: async () => {} }; },
  register: h.register, unregister: h.unregister, requestPermissions: async () => ({ receive: "granted" }),
  createChannel: async () => {}, removeAllDeliveredNotifications: async () => {},
} }));
vi.mock("@capacitor/local-notifications", () => ({ LocalNotifications: {
  addListener: async (name: string, fn: (v: any) => void) => { h.listeners[name] = fn; return { remove: async () => {} }; },
  checkPermissions: h.permission, requestPermissions: h.permission, schedule: h.schedule,
  createChannel: async () => {}, cancelAll: async () => {}, removeAllDeliveredNotifications: async () => {},
} }));
beforeEach(() => {
  vi.resetModules(); vi.stubEnv("VITE_MOBILE_BUILD", "true"); vi.stubEnv("VITE_ANDROID_PUSH_CONFIGURED", "true");
  localStorage.clear(); h.platform = "android"; h.current.status = "authenticated"; h.listeners = {};
  h.api.mockReset().mockResolvedValue({ ready: true, binding: "session-one" });
  h.permission.mockReset().mockResolvedValue({ display: "granted" });
  h.schedule.mockReset().mockResolvedValue({}); h.unregister.mockReset().mockResolvedValue({});
  h.register.mockReset().mockImplementation(async () => h.listeners.registration?.({ value: "fcm-device-token-1234567890" }));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("native notifications", () => {
  it.each(["android", "ios"])("registers a %s token with the signed-in server and shows a private local test", async (platform) => {
    h.platform = platform;
    const n = await import("../notifications"); await n.startNativeNotifications();
    expect(n.notificationSnapshot().phase).toBe("connected");
    const body = JSON.parse(h.api.mock.calls.find(([, init]) => init?.method === "POST")![1].body);
    expect(body.platform).toBe(platform); expect(body.token).toBe("fcm-device-token-1234567890");
    expect(body.installation).toMatch(/^[a-f\d-]{36}$/i);
    await n.showNativeNotification(true);
    expect(h.schedule.mock.calls[0]![0].notifications[0].extra.binding).toBe("session-one");
    await n.showNativeNotification(); // server owns delivery; foreground sync cannot duplicate it
    expect(h.schedule).toHaveBeenCalledTimes(1);
  });
  it("keeps local notifications available without initializing missing Firebase", async () => {
    vi.stubEnv("VITE_ANDROID_PUSH_CONFIGURED", "false");
    const n = await import("../notifications"); await n.startNativeNotifications();
    expect(n.notificationSnapshot().phase).toBe("unavailable"); expect(h.register).not.toHaveBeenCalled();
    await n.showNativeNotification(); expect(h.schedule).toHaveBeenCalledTimes(1);
    await n.stopNativeNotifications(); expect(h.unregister).not.toHaveBeenCalled();
  });
  it("does not register or show notifications when permission is denied", async () => {
    h.permission.mockResolvedValue({ display: "denied" });
    const n = await import("../notifications"); await n.startNativeNotifications(); await n.showNativeNotification(true);
    expect(h.register).not.toHaveBeenCalled(); expect(h.schedule).not.toHaveBeenCalled();
  });
  it("invalidates registration and notification callbacks immediately on logout", async () => {
    let finish!: (v: unknown) => void;
    h.api.mockImplementation(async (_path, init) => init?.method === "POST" ? new Promise((resolve) => { finish = resolve; }) : { ready: true, binding: "session-one" });
    const n = await import("../notifications"); const pending = n.startNativeNotifications();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    h.current.status = "anonymous"; await n.stopNativeNotifications();
    finish({ binding: "session-one" }); await pending;
    expect(n.notificationSnapshot().phase).toBe("idle");
    h.listeners.pushNotificationReceived!({ data: { binding: "session-one" } });
    await n.showNativeNotification(true); expect(h.schedule).not.toHaveBeenCalled();
    expect(h.unregister).toHaveBeenCalledOnce();
  });
  it("ignores another session's notification tap", async () => {
    const n = await import("../notifications"); await n.startNativeNotifications();
    const navigate = vi.spyOn(window.history, "pushState");
    h.listeners.pushNotificationActionPerformed!({ notification: { data: { binding: "previous-account" } } });
    await Promise.resolve(); expect(navigate).not.toHaveBeenCalled();
    h.listeners.pushNotificationActionPerformed!({ notification: { data: { binding: "session-one" } } });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({}, "", "/mail/inbox"));
  });
  it("cannot schedule a notification after logout races a permission check", async () => {
    const n = await import("../notifications"); await n.startNativeNotifications();
    let permit!: (v: unknown) => void;
    h.permission.mockImplementation(() => new Promise((resolve) => { permit = resolve; }));
    const pending = n.showNativeNotification(true);
    h.current.status = "anonymous"; await n.stopNativeNotifications(); permit({ display: "granted" }); await pending;
    expect(h.schedule).not.toHaveBeenCalled();
  });
});
