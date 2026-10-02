import { App as NativeApp } from "@capacitor/app";
import { Capacitor, CapacitorCookies, type PluginListenerHandle } from "@capacitor/core";
import { isNativeApp, mobileApiServerUrl, blockNativeSession, discardLegacyMobileServer } from "./config";

let active = true;
export function nativeAppIsActive(): boolean { return active; }

export async function clearNativeSession(): Promise<void> {
  if (!isNativeApp()) return;
  blockNativeSession();
  const url = mobileApiServerUrl();
  try {
    if (url) await CapacitorCookies.clearCookies({ url });
  } finally {
    const { clearNativeShareCache } = await import("./files");
    await clearNativeShareCache();
  }
}

let initialization: Promise<void> | null = null;
export function initializeNative(): Promise<void> {
  if (!isNativeApp()) return Promise.resolve();
  // StrictMode and retries share one successful initialization.
  return initialization ??= setupNative().catch((error: unknown) => {
    initialization = null;
    throw error;
  });
}

async function setupNative(): Promise<void> {
  document.documentElement.dataset.nativeApp = "true";
  if (discardLegacyMobileServer()) {
    blockNativeSession();
    const { clearAllData, setDeviceTrusted } = await import("@/lib/storage");
    setDeviceTrusted(false);
    clearAllData();
  }
  const handles: PluginListenerHandle[] = [];
  try {
    active = (await NativeApp.getState()).isActive;
    handles.push(await NativeApp.addListener("appStateChange", ({ isActive }) => {
      active = isActive;
      window.dispatchEvent(new CustomEvent("webmail:app-state", { detail: isActive }));
    }));
    if (Capacitor.getPlatform() === "android") {
      handles.push(await NativeApp.addListener("backButton", async ({ canGoBack }) => {
        const { confirmLeaveUnsaved } = await import("@/lib/unsavedChanges");
        if (!(await confirmLeaveUnsaved())) return;
        if (canGoBack) window.history.back();
        else await NativeApp.minimizeApp();
      }));
    }
    // Share files are temporary and should not outlive a launch.
    const { clearNativeShareCache } = await import("./files");
    await clearNativeShareCache();
  } catch (error) {
    await Promise.allSettled(handles.map((handle) => handle.remove()));
    throw error;
  }
}
