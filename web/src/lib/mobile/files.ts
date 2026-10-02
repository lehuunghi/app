import { Filesystem, Directory } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

const CACHE_PATH = "webmail-share";
export function isNativeShareDismissal(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || typeof error === "object" && error !== null && "message" in error && error.message === "Share canceled";
}
export async function clearNativeShareCache(): Promise<void> {
  try { await Filesystem.rmdir({ path: CACHE_PATH, directory: Directory.Cache, recursive: true }); } catch { /* not created yet */ }
}

export function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Cannot read file"));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(blob);
  });
}

/** The native share sheet includes Save to Files / a user's chosen target. */
export async function shareNativeFile(blob: Blob, filename: string, extra: { title?: string; text?: string } = {}): Promise<"shared" | "dismissed"> {
  const name = filename.replace(/[\\/\u0000-\u001f\u007f]/g, "_").replace(/^\.+$/, "file") || "attachment";
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const folder = `${CACHE_PATH}/${id}`;
  const path = `${folder}/${name}`;
  const saved = await Filesystem.writeFile({ path, directory: Directory.Cache, data: await blobBase64(blob), recursive: true });
  try {
    await Share.share({ ...extra, files: [saved.uri], dialogTitle: "Lưu hoặc chia sẻ tệp" });
    return "shared";
  } catch (error) {
    // A dismissed sheet has no recipient; keep no abandoned copy in its folder.
    try { await Filesystem.rmdir({ path: folder, directory: Directory.Cache, recursive: true }); } catch { /* cleared at next launch/logout */ }
    if (isNativeShareDismissal(error)) return "dismissed";
    throw error;
  }
}
