import { Capacitor } from "@capacitor/core";

const SERVER_KEY = "webmail:mobile-server";
const SIGNED_OUT_KEY = "webmail:mobile-signed-out";
let signedOut = false;
export function isNativeApp(): boolean {
  return import.meta.env.VITE_MOBILE_BUILD === "true" && Capacitor.isNativePlatform();
}

/** Accept only an HTTPS app root; never store credentials or URL tokens. */
export function normalizeServerUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTPS server address without credentials, query or fragment.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function mobileServerUrl(): string | null {
  try {
    const stored = localStorage.getItem(SERVER_KEY);
    return stored ? normalizeServerUrl(stored) : null;
  } catch {
    return null;
  }
}

export function saveMobileServer(input: string): void {
  localStorage.setItem(SERVER_KEY, normalizeServerUrl(input));
}

export function clearMobileServer(): void {
  localStorage.removeItem(SERVER_KEY);
}

/** Prevent an old native cookie from restoring a session after offline logout. */
export function nativeSessionBlocked(): boolean {
  if (!isNativeApp()) return false;
  try { return signedOut || localStorage.getItem(SIGNED_OUT_KEY) === "1"; }
  catch { return signedOut; }
}

export function blockNativeSession(): void {
  if (!isNativeApp()) return;
  signedOut = true;
  try { localStorage.setItem(SIGNED_OUT_KEY, "1"); } catch { /* keep the in-memory barrier */ }
}

/** Called only after an explicit sign-in succeeds. */
export function allowNativeSession(): void {
  if (!isNativeApp()) return;
  signedOut = false;
  try { localStorage.removeItem(SIGNED_OUT_KEY); } catch { /* a later launch may ask for sign-in again */ }
}

export function nativeApiUrl(path: string): string | null {
  if (!isNativeApp() || !path.startsWith("/api/")) return null;
  const server = mobileServerUrl();
  if (!server) throw new Error("Choose your Webmail server before signing in.");
  return server + path;
}

/** Resource checks are scoped to this app's API, not merely to the host. */
export function isNativeApiResource(input: string): boolean {
  if (!isNativeApp()) return false;
  const server = mobileServerUrl();
  if (!server) return false;
  try {
    const url = new URL(input);
    return !url.username && !url.password && !url.hash && url.href.startsWith(server + "/api/");
  } catch {
    return false;
  }
}
