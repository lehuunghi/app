import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Capacitor } from "@capacitor/core";
import { apiFetch, client } from "@/jmap/client";
import { saveMobileServer } from "../config";

beforeEach(() => {
  vi.stubEnv("VITE_MOBILE_BUILD", "true");
  vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
  localStorage.clear();
  saveMobileServer("https://mail.example.com/webmail");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("native API session transport", () => {
  it("sends login to the chosen API with cookies and the existing CSRF protocol", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await apiFetch("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "test", password: "test" }) });
    expect(fetchMock).toHaveBeenCalledWith("https://mail.example.com/webmail/api/auth/login", expect.objectContaining({
      credentials: "include", method: "POST", headers: expect.objectContaining({ "x-requested-with": "ihasmail" }),
    }));
    vi.stubEnv("VITE_MOBILE_BUILD", "false");
    await apiFetch("/api/auth/session");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/auth/session", expect.objectContaining({ credentials: "same-origin" }));
  });

  it("uses the native cookie jar for authenticated downloads and uploads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('content', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await client.fetchBlobText("a1", "b1")).toBe("content");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("https://mail.example.com/webmail/api/blob/a1/b1/"), { credentials: "include" });
    let xhr!: { withCredentials: boolean; open: ReturnType<typeof vi.fn>; setRequestHeader: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; upload: object; status: number; response: object; onload: () => void };
    vi.stubGlobal("XMLHttpRequest", class {
      constructor() { xhr = this as unknown as typeof xhr; }
      withCredentials = false;
      open = vi.fn(); setRequestHeader = vi.fn(); upload = {};
      status = 200; response = { blobId: "new" };
      onload = () => {};
      send = vi.fn(() => this.onload());
    });
    await client.upload("a1", new Blob(["file"]));
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.open).toHaveBeenCalledWith("POST", "https://mail.example.com/webmail/api/upload/a1");
    expect(xhr.setRequestHeader).toHaveBeenCalledWith("x-requested-with", "ihasmail");
  });
});
