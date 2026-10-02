import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/app.css";
import "./styles/webmail.css";
import "./styles/mobile.css";
import { App } from "./App";
import { startBuildWatch } from "@/lib/sw/staleBuild";
import { BASE_PATH, withBase } from "@/lib/basePath";
import { isNativeApp, mobileServerUrl } from "@/lib/mobile/config";
import { ServerSetup } from "@/lib/mobile/ServerSetup";
import { initializeNative } from "@/lib/mobile/runtime";
import { whenLanguageReady } from "@/lib/i18n";

if (!isNativeApp()) startBuildWatch();
const root = createRoot(document.getElementById("root")!);
const renderApp = () => root.render(<StrictMode><App /></StrictMode>);
async function launch() {
  if (!isNativeApp()) { renderApp(); return; }
  await whenLanguageReady();
  await initializeNative();
  if (!mobileServerUrl()) root.render(<StrictMode><ServerSetup onReady={renderApp} /></StrictMode>);
  else renderApp();
}
void launch();

if (!isNativeApp() && import.meta.env.VITE_MOBILE_BUILD !== "true" && "serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    /*
     * The scope is spelled out rather than left to default to the script's own
     * directory. Both come to `${BASE_PATH}/` today, but the default is a
     * property of where the file happens to sit, and this is a statement about
     * what the worker is allowed to control -- which under a prefix must stop
     * at the mount. A worker scoped to `/` on a host shared with other
     * applications would intercept their navigations too, and its offline
     * fallback would answer them with ihasmail's shell.
     */
    navigator.serviceWorker.register(withBase("/sw.js"), { scope: `${BASE_PATH}/` }).catch(() => {
      /* ignore */
    });
  });
}
