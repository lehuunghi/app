import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
beforeEach(() => { vi.resetModules(); localStorage.clear(); vi.stubEnv("VITE_MOBILE_BUILD", "true"); });
afterEach(() => { vi.unstubAllEnvs(); });
describe("persistent native sign-out barrier", () => {
  it("survives a new app process and server changes without storing account credentials", async () => {
    const first = await import("../config");
    first.saveMobileServer("https://one.example.com"); first.blockNativeSession();
    first.clearMobileServer(); first.saveMobileServer("https://two.example.com");
    vi.resetModules();
    const relaunched = await import("../config");
    expect(relaunched.nativeSessionBlocked()).toBe(true);
    expect([...Array(localStorage.length)].map((_, i) => localStorage.key(i)).sort()).toEqual(["webmail:mobile-server", "webmail:mobile-signed-out"]);
    relaunched.allowNativeSession();
    expect(relaunched.nativeSessionBlocked()).toBe(false);
  });
});
