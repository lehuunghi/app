import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  state: vi.fn(), listen: vi.fn(), remove: vi.fn(), clearCookies: vi.fn(), clearCache: vi.fn(), block: vi.fn(), legacy: vi.fn(), clearData: vi.fn(), trust: vi.fn(), platform: "android",
}));
vi.mock("@capacitor/app", () => ({ App: { getState: native.state, addListener: native.listen } }));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => native.platform }, CapacitorCookies: { clearCookies: native.clearCookies } }));
vi.mock("../config", () => ({ isNativeApp: () => true, mobileServerUrl: () => "https://jmail.vn", blockNativeSession: native.block, discardLegacyMobileServer: native.legacy }));
vi.mock("@/lib/storage", () => ({ clearAllData: native.clearData, setDeviceTrusted: native.trust }));
vi.mock("../files", () => ({ clearNativeShareCache: native.clearCache }));

beforeEach(() => {
  vi.resetModules();
  native.platform = "android";
  native.state.mockReset().mockResolvedValue({ isActive: true });
  native.remove.mockReset().mockResolvedValue(undefined);
  native.listen.mockReset().mockResolvedValue({ remove: native.remove });
  native.clearCookies.mockReset().mockResolvedValue(undefined);
  native.clearCache.mockReset().mockResolvedValue(undefined);
  native.block.mockReset();
  native.legacy.mockReset().mockReturnValue(false);
  native.clearData.mockReset(); native.trust.mockReset();
});

describe("native startup and sign-out recovery", () => {
  it("clears cached account data and blocks restore when upgrading from another server", async () => {
    native.legacy.mockReturnValueOnce(true);
    const runtime = await import("../runtime");
    await runtime.initializeNative();
    expect(native.block).toHaveBeenCalledOnce();
    expect(native.trust).toHaveBeenCalledWith(false);
    expect(native.clearData).toHaveBeenCalledOnce();
    expect(native.clearData.mock.invocationCallOrder[0]).toBeLessThan(native.state.mock.invocationCallOrder[0]!);
  });

  it("removes partial listeners on failure and allows one successful retry", async () => {
    native.listen.mockResolvedValueOnce({ remove: native.remove }).mockRejectedValueOnce(new Error("bridge failed"));
    const runtime = await import("../runtime");
    await expect(runtime.initializeNative()).rejects.toThrow("bridge failed");
    expect(native.remove).toHaveBeenCalledTimes(1);
    await Promise.all([runtime.initializeNative(), runtime.initializeNative()]);
    expect(native.state).toHaveBeenCalledTimes(2);
    expect(native.listen).toHaveBeenCalledTimes(4);
    expect(native.clearCache).toHaveBeenCalledTimes(1);
  });

  it("clears temporary files and blocks automatic session restore even if cookie deletion fails", async () => {
    native.clearCookies.mockRejectedValue(new Error("cookie bridge failed"));
    const runtime = await import("../runtime");
    await expect(runtime.clearNativeSession()).rejects.toThrow("cookie bridge failed");
    expect(native.block).toHaveBeenCalledTimes(1);
    expect(native.clearCache).toHaveBeenCalledTimes(1);
  });

  it("uses lifecycle updates on iOS without registering an Android back button", async () => {
    native.platform = "ios";
    const runtime = await import("../runtime");
    await runtime.initializeNative();
    expect(native.listen).toHaveBeenCalledTimes(1);
    expect(native.listen.mock.calls[0]?.[0]).toBe("appStateChange");
    const notify = vi.fn();
    window.addEventListener("webmail:app-state", notify);
    native.listen.mock.calls[0]?.[1]({ isActive: false });
    expect(runtime.nativeAppIsActive()).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    window.removeEventListener("webmail:app-state", notify);
  });
});
