import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
import { discardLegacyMobileServer, isNativeApiResource, mobileServerUrl, MOBILE_SERVER_URL } from "../config";
import { withBase } from "@/lib/basePath";

beforeEach(() => { localStorage.clear(); vi.stubEnv("VITE_MOBILE_BUILD", "true"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("fixed mobile server boundary", () => {
  it("connects to jmail.vn on a clean installation and keeps bundled assets local", () => {
    expect(mobileServerUrl()).toBe("https://jmail.vn");
    expect(withBase("/api/auth/login")).toBe("https://webmail.jmail.vn/api/auth/login");
    expect(withBase("/api/auth/session")).toBe("https://webmail.jmail.vn/api/auth/session");
    expect(withBase("/img/webmail.svg")).toBe("/img/webmail.svg");
    expect(isNativeApiResource("https://webmail.jmail.vn/api/blob/a/b/x")).toBe(true);
  });

  it("ignores legacy server settings and never accepts another host's resources", () => {
    localStorage.setItem("webmail:mobile-server", "https://old.example.com/mail");
    expect(mobileServerUrl()).toBe(MOBILE_SERVER_URL);
    expect(withBase("/api/jmap")).toBe("https://webmail.jmail.vn/api/jmap");
    for (const url of ["https://old.example.com/api/blob/a/b/x", "https://webmail.jmail.vn.evil.test/api/blob/a/b/x", "https://webmail.jmail.vn/api/../outside", "http://webmail.jmail.vn/api/blob/a", "https://user:secret@webmail.jmail.vn/api/blob/a", "https://webmail.jmail.vn/api/blob/a#token"]) {
      expect(isNativeApiResource(url)).toBe(false);
    }
  });

  it("discards another deployment's setting once, while preserving a jmail upgrade", () => {
    localStorage.setItem("webmail:mobile-server", "https://old.example.com");
    expect(discardLegacyMobileServer()).toBe(true);
    expect(localStorage.getItem("webmail:mobile-server")).toBeNull();
    expect(discardLegacyMobileServer()).toBe(false);
    localStorage.setItem("webmail:mobile-server", "https://jmail.vn/");
    expect(discardLegacyMobileServer()).toBe(false);
    expect(localStorage.getItem("webmail:mobile-server")).toBeNull();
    localStorage.setItem("webmail:mobile-server", "https://webmail.jmail.vn");
    expect(discardLegacyMobileServer()).toBe(false);
  });

  it("keeps ordinary web builds on their own origin", () => {
    vi.stubEnv("VITE_MOBILE_BUILD", "false");
    expect(withBase("/api/auth/login")).toBe("/api/auth/login");
  });
});
