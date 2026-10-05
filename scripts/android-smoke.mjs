import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const pkg = "com.lehuunghi.webmail";
mkdirSync("android-smoke", { recursive: true });
const adb = (...args) => execFileSync("adb", args, { encoding: "utf8", timeout: 30000 });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let launcherRecoveries = 0;
let stage = "install";
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
  for (let attempt = 0; attempt < 30; attempt++) {
    await pause(1500);
    try {
      const xml = dump();
      const screen = nodes(xml);
      // Recover only an emulator system launcher ANR, never a Webmail fault.
      const launcherAnr = screen.some((n) => n.package === "android" && n["resource-id"] === "android:id/alertTitle" && /^Pixel Launcher (?:isn\x27t responding|keeps stopping)$/.test(n.text ?? ""));
      const closeLauncher = launcherAnr && screen.find((n) => n["resource-id"] === "android:id/aerr_close");
      if (closeLauncher) {
        tap(closeLauncher);
        launcherRecoveries++;
        console.log("Recovered emulator Pixel Launcher dialog");
        adb("shell", "am", "start", "-W", "-n", pkg + "/.MainActivity");
        continue;
      }
      if (predicate(xml)) return xml;
    } catch { /* accessibility can be unavailable during the first emulator frames */ }
  }
  throw new Error("App did not reach the expected screen");
}
let report;
try {
  adb("install", "-r", "dist/app-debug.apk");
  stage = "launch";
  adb("shell", "am", "start", "-W", "-n", pkg + "/.MainActivity");
  stage = "login-screen";
  const launch = await waitFor((xml) => nodes(xml).filter((n) => n.class === "android.widget.EditText").length === 2);
  if (!/Sử dụng tài khoản của bạn để truy cập không gian làm việc\.|Use your account to access your workspace\./.test(launch)) throw new Error("Updated sign-in screen is missing");
  if (/https:\/\/(?:webmail\.)?jmail\.vn|AGPL-3\.0 source|Mã nguồn AGPL-3\.0/i.test(launch)) throw new Error("Public login footer is still visible");
  writeFileSync("android-smoke/login.xml", launch);
  writeFileSync("android-smoke/login.png", execFileSync("adb", ["exec-out", "screencap", "-p"]));
  if (/Connect to your Webmail server|Địa chỉ máy chủ Webmail|Change Webmail server|Đổi máy chủ Webmail/.test(launch)) throw new Error("Server picker is still visible");
  const fields = nodes(launch).filter((n) => n.class === "android.widget.EditText");
  tap(fields[0]); adb("shell", "input", "text", "codex-smoke-" + Date.now() + "@jmail.vn");
  const passwordScreen = await waitFor((xml) => nodes(xml).filter((n) => n.class === "android.widget.EditText").length === 2);
  tap(nodes(passwordScreen).filter((n) => n.class === "android.widget.EditText")[1]); adb("shell", "input", "text", "invalid-smoke-password"); adb("shell", "input", "keyevent", "4");
  const isSignIn = (n) => n.class === "android.widget.Button" && /^(Đăng nhập|Sign in)$/.test(n.text || n["content-desc"]);
  const filled = await waitFor((xml) => nodes(xml).some(isSignIn));
  const signIn = nodes(filled).find(isSignIn);
  if (!signIn) throw new Error("Sign-in button unavailable");
  stage = "invalid-login";
  tap(signIn);
  const rejected = await waitFor((xml) => /Tên đăng nhập hoặc mật khẩu không đúng\.|Invalid username or password\.|Đang lỗi kết nối, mời bạn kiểm tra lại\.|Network error\. Please check your connection\./i.test(xml));
  writeFileSync("android-smoke/invalid-login.xml", rejected);
  writeFileSync("android-smoke/invalid-login.png", execFileSync("adb", ["exec-out", "screencap", "-p"]));
  const invalidLoginRejected = /Tên đăng nhập hoặc mật khẩu không đúng\.|Invalid username or password\./i.test(rejected);
  const connectionErrorShown = /Đang lỗi kết nối, mời bạn kiểm tra lại\.|Network error\. Please check your connection\./i.test(rejected);
  report = { installed: true, launched: true, updatedLoginVisible: true, serverPickerRemoved: true, publicLoginFooterRemoved: true,
    invalidLoginRejected, connectionErrorShown, backendReachable: invalidLoginRejected, launcherRecoveries,
    authenticatedMailTest: "No test account supplied; deployment compatibility is checked separately" };
} catch (error) {
  try {
    const xml = dump();
    writeFileSync("android-smoke/failure.xml", xml);
    console.log("Failure screen: " + xml);
  } catch { /* preserve the original failure */ }
  try { writeFileSync("android-smoke/failure.png", execFileSync("adb", ["exec-out", "screencap", "-p"])); } catch { /* preserve the original failure */ }
  report = { error: error.message, stage, launcherRecoveries }; process.exitCode = 1;
} finally {
  writeFileSync("android-smoke/report.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
