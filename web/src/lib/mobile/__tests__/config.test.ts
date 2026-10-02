import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
import { clearMobileServer, isNativeApiResource, normalizeServerUrl, saveMobileServer } from "../config";
import { withBase } from "@/lib/basePath";

beforeEach(() => { localStorage.clear(); vi.stubEnv("VITE_MOBILE_BUILD", "true"); });

describe("mobile server boundary", () => {
  it("normalizes an HTTPS mount and keeps bundled assets local", () => {
    saveMobileServer(" https://webmail.example.com/mail/ ");
    expect(withBase("/api/auth/login")).toBe("https://webmail.example.com/mail/api/auth/login");
    expect(withBase("/img/webmail.svg")).toBe("/img/webmail.svg");
    expect(isNativeApiResource("https://webmail.example.com/mail/api/blob/a/b/x")).toBe(true);
    expect(isNativeApiResource("https://webmail.example.com/other/api/blob/a/b/x")).toBe(false);
    expect(isNativeApiResource("https://webmail.example.com.evil.test/mail/api/blob/a/b/x")).toBe(false);
    expect(isNativeApiResource("https://webmail.example.com/mail/api/../outside")).toBe(false);
  });

  it("never saves URL credentials, token queries, fragments or HTTP", () => {
    for (const url of ["http://mail.example.com", "https://user:secret@mail.example.com", "https://mail.example.com/?token=secret", "https://mail.example.com/#token", "javascript:alert(1)", "not a URL"]) {
      expect(() => normalizeServerUrl(url)).toThrow();
    }
    expect(localStorage.length).toBe(0);
  });

  it("requires server selection before native API requests", () => {
    expect(() => withBase("/api/auth/session")).toThrow();
    saveMobileServer("https://mail.example.com");
    clearMobileServer();
    expect(() => withBase("/api/auth/session")).toThrow();
  });

  it("keeps ordinary web builds on their own origin", () => {
    saveMobileServer("https://mail.example.com");
    vi.stubEnv("VITE_MOBILE_BUILD", "false");
    expect(withBase("/api/auth/login")).toBe("/api/auth/login");
  });
});
