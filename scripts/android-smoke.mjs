import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const pkg = "com.lehuunghi.webmail";
mkdirSync("android-smoke", { recursive: true });
const adb = (...args) => execFileSync("adb", args, { encoding: "utf8", timeout: 30000 });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function dump() {
  adb("shell", "uiautomator", "dump", "/sdcard/window.xml");
  return adb("shell", "cat", "/sdcard/window.xml");
}
function nodes(xml) {
  return [...xml.matchAll(/<node\s+([^>]+)>/g)].map((m) =>
    Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((p) => [p[1], p[2]])));
}
function tap(node) {
  const b = node.bounds?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!b) throw new Error("No usable bounds");
  adb("shell", "input", "tap", String(Math.round((+b[1] + +b[3]) / 2)), String(Math.round((+b[2] + +b[4]) / 2)));
}
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt++) {
    await pause(1500);
    try {
      const xml = dump();
      if (predicate(xml)) return xml;
    } catch { /* accessibility can be unavailable during the first emulator frames */ }
  }
  throw new Error("App did not reach the expected screen");
}
let report;
try {
  adb("install", "-r", "dist/app-debug.apk");
  adb("shell", "am", "start", "-W", "-n", pkg + "/.MainActivity");
  const launch = await waitFor((xml) => nodes(xml).filter((n) => n.class === "android.widget.EditText").length === 2);
  writeFileSync("android-smoke/login.xml", launch);
  writeFileSync("android-smoke/login.png", execFileSync("adb", ["exec-out", "screencap", "-p"]));
  if (/Connect to your Webmail server|Địa chỉ máy chủ Webmail|Change Webmail server|Đổi máy chủ Webmail/.test(launch)) throw new Error("Server picker is still visible");
  const fields = nodes(launch).filter((n) => n.class === "android.widget.EditText");
  tap(fields[0]); adb("shell", "input", "text", "codex-smoke-" + Date.now() + "@jmail.vn");
  const passwordScreen = await waitFor((xml) => nodes(xml).filter((n) => n.class === "android.widget.EditText").length === 2);
  tap(nodes(passwordScreen).filter((n) => n.class === "android.widget.EditText")[1]); adb("shell", "input", "text", "invalid-smoke-password"); adb("shell", "input", "keyevent", "4");
  const filled = await waitFor((xml) => nodes(xml).some((n) => /^(Đăng nhập|Sign in)$/.test(n.text || n["content-desc"])));
  const signIn = nodes(filled).find((n) => /^(Đăng nhập|Sign in)$/.test(n.text || n["content-desc"]));
  if (!signIn) throw new Error("Sign-in button unavailable");
  tap(signIn);
  const rejected = await waitFor((xml) => /Tên đăng nhập hoặc mật khẩu không đúng\.|Invalid username or password\./i.test(xml));
  writeFileSync("android-smoke/invalid-login.xml", rejected);
  writeFileSync("android-smoke/invalid-login.png", execFileSync("adb", ["exec-out", "screencap", "-p"]));
  report = { installed: true, launched: true, serverPickerRemoved: true, invalidLoginRejected: true, authenticatedMailTest: "No test account supplied" };
} catch (error) {
  try {
    writeFileSync("android-smoke/failure.xml", dump());
  } catch { /* preserve the original failure */ }
  try { writeFileSync("android-smoke/failure.png", execFileSync("adb", ["exec-out", "screencap", "-p"])); } catch { /* preserve the original failure */ }
  report = { error: error.message }; process.exitCode = 1;
} finally {
  writeFileSync("android-smoke/report.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
