import { Capacitor } from "@capacitor/core";

const SERVER_KEY = "webmail:mobile-server";
const SIGNED_OUT_KEY = "webmail:mobile-signed-out";
let signedOut = false;
export function isNativeApp(): boolean {
  return import.meta.env.VITE_MOBILE_BUILD === "true" && Capacitor.isNativePlatform();
}

/** This app always connects to the same deployment, including after upgrades. */
export const MOBILE_SERVER_URL = "https://jmail.vn";
// jmail.vn redirects its website here; the Node API is served on this origin.
export const MOBILE_API_URL = "https://webmail.jmail.vn";

export function mobileApiServerUrl(): string {
  return MOBILE_API_URL;
}

export function mobileServerUrl(): string {
  return MOBILE_SERVER_URL;
}

/** Discard the old picker value and tell startup to clear another server's data. */
export function discardLegacyMobileServer(): boolean {
  try {
    const previous = localStorage.getItem(SERVER_KEY);
    localStorage.removeItem(SERVER_KEY);
    return Boolean(previous && ![MOBILE_SERVER_URL, MOBILE_API_URL].includes(previous.replace(/\/+$/, "")));
  } catch {
    return false;
  }
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
  return MOBILE_API_URL + path;
}

/** Resource checks are scoped to this app's API, not merely to the host. */
export function isNativeApiResource(input: string): boolean {
  if (!isNativeApp()) return false;
  const server = MOBILE_API_URL;
  try {
    const url = new URL(input);
    return !url.username && !url.password && !url.hash && url.href.startsWith(server + "/api/");
  } catch {
    return false;
  }
}
