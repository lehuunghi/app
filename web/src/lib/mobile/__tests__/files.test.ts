import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ write: vi.fn(), remove: vi.fn(), share: vi.fn() }));
vi.mock("@capacitor/filesystem", () => ({ Directory: { Cache: "CACHE" }, Filesystem: { writeFile: api.write, rmdir: api.remove } }));
vi.mock("@capacitor/share", () => ({ Share: { share: api.share } }));
vi.mock("../config", () => ({ isNativeApp: () => true }));
import { shareNativeFile } from "../files";
import { shareText } from "@/lib/share";

beforeEach(() => {
  api.write.mockReset().mockResolvedValue({ uri: "file:///cache/test" });
  api.remove.mockReset().mockResolvedValue(undefined);
  api.share.mockReset().mockResolvedValue({ activityType: "target" });
});

describe("native share sheet outcomes", () => {
  it("treats cancellation as dismissal and removes only that temporary file folder", async () => {
    api.share.mockRejectedValue(new Error("Share canceled"));
    expect(await shareNativeFile(new Blob(["mail"]), "../thư.txt")).toBe("dismissed");
    const written = api.write.mock.calls[0]?.[0].path as string;
    expect(written).toMatch(/^webmail-share\/[^/]+\/\.{2}_thư\.txt$/);
    expect(api.remove).toHaveBeenCalledWith({ path: written.slice(0, written.lastIndexOf("/")), directory: "CACHE", recursive: true });
  });

  it("keeps a successfully shared file available for its recipient", async () => {
    expect(await shareNativeFile(new Blob(["mail"]), "thư.txt")).toBe("shared");
    expect(api.remove).not.toHaveBeenCalled();
  });

  it("reports real share failures rather than treating them as cancellation", async () => {
    api.share.mockRejectedValue(new Error("storage unavailable"));
    await expect(shareNativeFile(new Blob(["mail"]), "mail.txt")).rejects.toThrow("storage unavailable");
    await expect(shareText({ text: "mail" })).rejects.toThrow("storage unavailable");
    api.share.mockRejectedValue(new Error("Share canceled"));
    expect(await shareText({ text: "mail" })).toBe("dismissed");
  });
});
