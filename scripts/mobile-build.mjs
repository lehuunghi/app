import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// Mobile always serves its bundled assets at its local origin. The API's
// origin is https://webmail.jmail.vn, advertised by https://jmail.vn.
let androidPushConfigured = false;
const googleServices = new URL("../android/app/google-services.json", import.meta.url);
if (existsSync(googleServices)) {
  const services = JSON.parse(readFileSync(googleServices, "utf8"));
  if (!services.project_info?.project_id || !services.client?.some((c) => c.client_info?.android_client_info?.package_name === "com.lehuunghi.webmail")) {
    throw new Error("google-services.json must belong to com.lehuunghi.webmail");
  }
  androidPushConfigured = true;
}
const env = { ...process.env, BASE_PATH: "", VITE_MOBILE_BUILD: "true", VITE_ANDROID_PUSH_CONFIGURED: String(androidPushConfigured) };
const run = (args) => {
  const r = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run(["node_modules/typescript-ast/bin/tsc", "-p", "web/tsconfig.json", "--noEmit"]);
run(["node_modules/vite/bin/vite.js", "build", "web", "--config", "web/vite.config.ts", "--outDir", "../mobile-dist", "--emptyOutDir"]);
// A native app updates through its binary. A service worker must never replace
// the packaged shell with assets from a different server or release.
rmSync(new URL("../mobile-dist/sw.js", import.meta.url), { force: true });
const config = JSON.parse(readFileSync(new URL("../capacitor.config.json", import.meta.url)));
if (config.server?.url || config.server?.cleartext || !existsSync(new URL("../mobile-dist/index.html", import.meta.url))) {
  throw new Error("Invalid native build: use bundled assets and HTTPS APIs.");
}
