import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "../client";
import { loadLanguage } from "@/lib/i18n";
afterEach(async () => { vi.unstubAllGlobals(); await loadLanguage("en"); });
describe("connection errors", () => {
  it("hides network and upstream details behind the requested Vietnamese message", async () => {
    await loadLanguage("vi");
    const message = "Đang lỗi kết nối, mời bạn kiểm tra lại.";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch https://private-server")));
    await expect(apiFetch("/api/auth/login")).rejects.toThrow(message);
    for (const status of [502, 503, 504]) expect(new ApiError(status, "upstream_error", "ECONNREFUSED private:8080").message).toBe(message);
    expect(new ApiError(401, "invalid_credentials", "Invalid credentials").message).toBe("Invalid credentials");
    expect(new ApiError(0, "aborted", "Upload canceled").message).toBe("Upload canceled");
  });
});
