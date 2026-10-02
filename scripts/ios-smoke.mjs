import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("ios-smoke", { recursive: true });
const run = (...args) => execFileSync("xcrun", args, { encoding: "utf8", timeout: 180000 });
let report;
let device;
try {
  const devices = JSON.parse(run("simctl", "list", "devices", "available", "--json")).devices;
  device = Object.values(devices).flat().find((d) => d.isAvailable && d.name.startsWith("iPhone"));
  if (!device) throw new Error("No iPhone simulator available");
  if (device.state !== "Booted") run("simctl", "boot", device.udid);
  run("simctl", "bootstatus", device.udid, "-b");
  run("simctl", "install", device.udid, "ios/build/Build/Products/Debug-iphonesimulator/App.app");
  const launch = run("simctl", "launch", device.udid, "com.lehuunghi.webmail");
  await new Promise((resolve) => setTimeout(resolve, 10000));
  const running = run("simctl", "spawn", device.udid, "launchctl", "list");
  if (!running.includes("com.lehuunghi.webmail")) throw new Error("App exited after launch");
  run("simctl", "io", device.udid, "screenshot", "ios-smoke/login.png");
  report = { device: device.name, installed: true, launched: true, stillRunning: true, launch: launch.trim(), authenticatedMailTest: "No test account supplied" };
} catch (error) {
  report = { error: error.message }; process.exitCode = 1;
} finally {
  writeFileSync("ios-smoke/report.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
