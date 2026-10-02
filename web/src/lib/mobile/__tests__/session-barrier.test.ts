import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
beforeEach(() => { vi.resetModules(); localStorage.clear(); vi.stubEnv("VITE_MOBILE_BUILD", "true"); });
afterEach(() => { vi.unstubAllEnvs(); });
describe("persistent native sign-out barrier", () => {
  it("survives a new app process without a configurable server without storing account credentials", async () => {
    const first = await import("../config");
    first.blockNativeSession();
    vi.resetModules();
    const relaunched = await import("../config");
    expect(relaunched.nativeSessionBlocked()).toBe(true);
    expect([...Array(localStorage.length)].map((_, i) => localStorage.key(i)).sort()).toEqual(["webmail:mobile-signed-out"]);
    expect(relaunched.mobileServerUrl()).toBe("https://jmail.vn");
    relaunched.allowNativeSession();
    expect(relaunched.nativeSessionBlocked()).toBe(false);
  });
});
