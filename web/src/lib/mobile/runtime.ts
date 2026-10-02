import { App as NativeApp } from "@capacitor/app";
import { CapacitorCookies } from "@capacitor/core";
import { isNativeApp, mobileServerUrl } from "./config";

let active = true;
export function nativeAppIsActive(): boolean { return active; }

export async function clearNativeSession(): Promise<void> {
  const url = mobileServerUrl();
  if (isNativeApp() && url) {
    await CapacitorCookies.clearCookies({ url });
    const { clearNativeShareCache } = await import("./files");
    await clearNativeShareCache();
  }
}

export async function initializeNative(): Promise<void> {
  if (!isNativeApp()) return;
  document.documentElement.dataset.nativeApp = "true";
  active = (await NativeApp.getState()).isActive;
  await NativeApp.addListener("appStateChange", ({ isActive }) => {
    active = isActive;
    window.dispatchEvent(new CustomEvent("webmail:app-state", { detail: isActive }));
  });
  await NativeApp.addListener("backButton", async ({ canGoBack }) => {
    const { confirmLeaveUnsaved } = await import("@/lib/unsavedChanges");
    if (!(await confirmLeaveUnsaved())) return;
    if (canGoBack) window.history.back();
    else await NativeApp.minimizeApp();
  });
  // Share files are temporary and should not outlive a launch.
  const { clearNativeShareCache } = await import("./files");
  await clearNativeShareCache();
}
