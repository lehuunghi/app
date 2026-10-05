import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Capacitor } from "@capacitor/core";
const network = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/jmap/client", async (original) => ({ ...await original<object>(), apiFetch: network.api }));
vi.mock("../runtime", () => ({ clearNativeSession: async () => { throw new Error("cookie bridge unavailable"); } }));
vi.mock("../notifications", () => ({ stopNativeNotifications: async () => {} }));
vi.mock("@/lib/notify/webpush", () => ({ unsubscribeThisDevice: async () => {} }));
vi.mock("@/lib/settingsSync", () => ({ flushSettingsPush: async () => {}, stopSettingsSync: () => {} }));
import { useSession } from "@/store/session";
import { CAP, client } from "@/jmap/client";
import { allowNativeSession, blockNativeSession, nativeSessionBlocked } from "../config";
import { stopIdleLogout } from "@/lib/idleLogout";
import type { JmapSession } from "@/jmap/types";

const session = {
  capabilities: { [CAP.core]: {}, [CAP.mail]: {} },
  accounts: { a1: { name: "me", isPersonal: true, isReadOnly: false, accountCapabilities: { [CAP.mail]: {} } } },
  primaryAccounts: { [CAP.mail]: "a1" }, state: "1", username: "me", apiUrl: "", uploadUrl: "", downloadUrl: "", eventSourceUrl: "",
  ihasmail: { appName: "Webmail", remember: true, sessionId: "test", loginName: "me", imageProxy: false, maxUploadBytes: 1000 },
} satisfies JmapSession;

beforeEach(() => {
  vi.stubEnv("VITE_MOBILE_BUILD", "true");
  vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
  localStorage.clear(); allowNativeSession();
  client.session = null;
  useSession.setState({ status: "loading", session: null, accountId: null, error: null });
  network.api.mockReset().mockResolvedValue(session);
});
afterEach(() => { stopIdleLogout(); allowNativeSession(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("native session restore after sign-out", () => {
  it.each(["bootstrap", "refresh"] as const)("discards an old %s response even after another account signs in", async (method) => {
    await useSession.getState().login("me", "test", "", true);
    let complete!: (value: JmapSession) => void;
    network.api.mockImplementationOnce(() => new Promise<JmapSession>((resolve) => { complete = resolve; }));
    const pending = useSession.getState()[method]();
    await useSession.getState().logout();
    const next = { ...session, username: "other-account", state: "2" };
    network.api.mockResolvedValue(next);
    await useSession.getState().login("other-account", "test", "", true);
    complete(session); await pending;
    expect(client.session?.username).toBe("other-account");
    expect(useSession.getState().session?.username).toBe("other-account");
  });

  it("stays signed out after offline logout and a failed native cookie cleanup", async () => {
    await useSession.getState().login("me", "test", "", true);
    network.api.mockRejectedValue(new Error("offline"));
    await useSession.getState().logout();
    expect(nativeSessionBlocked()).toBe(true);
    expect(localStorage.getItem("webmail:mobile-signed-out")).toBe("1");
    network.api.mockClear().mockResolvedValue(session);
    useSession.setState({ status: "loading" });
    await useSession.getState().bootstrap();
    expect(network.api).not.toHaveBeenCalled();
    expect(useSession.getState().status).toBe("anonymous");
    expect(client.session).toBeNull();
  });

  it("keeps the sign-out barrier on a failed login and removes it only after a successful login", async () => {
    blockNativeSession();
    network.api.mockRejectedValueOnce(new Error("bad password"));
    await expect(useSession.getState().login("me", "wrong", "", true)).rejects.toThrow("bad password");
    expect(nativeSessionBlocked()).toBe(true);
    network.api.mockResolvedValue(session);
    await useSession.getState().login("me", "test", "", true);
    expect(nativeSessionBlocked()).toBe(false);
    expect(useSession.getState().status).toBe("authenticated");
  });
});
