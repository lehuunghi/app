import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(root + path, "utf8");
const config = JSON.parse(read("capacitor.config.json"));
if (config.webDir !== "mobile-dist" || config.server?.url || config.server?.cleartext || config.android?.allowMixedContent) throw new Error("Native apps must bundle their UI and use HTTPS APIs.");
if (config.plugins?.CapacitorHttp?.enabled !== true) throw new Error("Native HTTP transport must be enabled.");
for (const path of ["mobile-dist/index.html", "android/app/src/main/java/com/lehuunghi/webmail/MainActivity.java", "ios/App/App.xcodeproj/project.pbxproj", "ios/App/App/PrivacyInfo.xcprivacy"]) {
  if (!existsSync(root + path)) throw new Error(`Missing generated file: ${path}`);
}
if (existsSync(root + "mobile-dist/sw.js")) throw new Error("A service worker must not update the packaged UI.");
const spm = read("ios/App/CapApp-SPM/Package.swift");
for (const plugin of ["CapacitorApp", "CapacitorFilesystem", "CapacitorShare", "CapacitorLocalNotifications", "CapacitorPushNotifications"]) {
  if (!spm.includes(plugin)) throw new Error(`Run cap sync: iOS plugin missing: ${plugin}`);
}
const android = JSON.parse(read("android/app/src/main/assets/capacitor.plugins.json"));
if (android.length < 5) throw new Error("Run cap sync: Android plugins missing.");
if (!read("android/app/src/main/AndroidManifest.xml").includes('android:allowBackup="false"')) throw new Error("Mail storage should not enter Android backups.");
console.log("Mobile assets, HTTPS configuration, native plugin registration and platform projects verified.");
console.log("APK/IPA compilation and real-device testing still require the Android/iOS toolchains.");
