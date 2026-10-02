import { isNativeApp } from "./mobile/config";

async function reportDownloadError(): Promise<void> {
  const { toast } = await import("@/ui/toast");
  const { t } = await import("./i18n");
  toast.error(t("Could not save or share the file. Please try again."));
}

export function downloadUrl(url: string, filename: string): void {
  if (isNativeApp()) {
    void fetch(url, { credentials: "include" }).then(async (response) => {
      if (!response.ok) throw new Error("Download failed");
      const { shareNativeFile } = await import("./mobile/files");
      await shareNativeFile(await response.blob(), filename);
    }).catch(reportDownloadError);
    return;
  }
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
}

export function openFileUrl(url: string, filename = "attachment"): void {
  if (isNativeApp()) downloadUrl(url, filename);
  else window.open(url, "_blank", "noopener");
}

/**
 * Hand the browser a file the app made, to save.
 *
 * The object URL is released as soon as the download has been started: a
 * click on the link starts it synchronously, and an unreleased URL keeps the
 * whole file in memory for as long as the tab is open -- an address book's
 * worth of vCards, per export.
 */
export function downloadFile(content: BlobPart, type: string, filename: string): void {
  if (isNativeApp()) {
    void import("./mobile/files").then(({ shareNativeFile }) => shareNativeFile(new Blob([content], { type }), filename)).catch(reportDownloadError);
    return;
  }
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
