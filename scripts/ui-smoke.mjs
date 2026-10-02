import { spawn } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("../.ui-tools/node_modules/playwright");
mkdirSync("ui-smoke", { recursive: true });
cpSync("mobile-dist", "web/dist", { recursive: true });
const children = [];
const start = (args, env = {}) => {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  children.push({ child, output: () => output });
  return child;
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function ready(url) {
  for (let i = 0; i < 60; i++) {
    try { const response = await fetch(url); if (response.ok || response.status === 401) return; } catch { /* server starting */ }
    await pause(500);
  }
  throw new Error("Test server unavailable: " + url);
}
async function visible(page, selector) { await page.locator(selector).first().waitFor({ state: "visible", timeout: 30000 }); }
async function fits(page, selector) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box || box.x < -1 || box.x + box.width > page.viewportSize().width + 1) throw new Error("Control outside viewport: " + selector);
}
async function noOverflow(page) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  if (width > page.viewportSize().width + 1) throw new Error("Page scrolls horizontally: " + width);
}
let browser;
let active;
const report = { backend: "Local mock JMAP with demo account; no production mailbox", cases: [] };
try {
  start(["--import", "tsx", "server/src/mock/index.ts"], { MOCK_USER: "demo", MOCK_PASS: "demo" });
  await ready("http://127.0.0.1:8788/.well-known/jmap");
  start(["server/dist/index.js"], { HOST: "127.0.0.1", PORT: "8080", STALWART_URL: "http://127.0.0.1:8788", APP_SECRET: randomBytes(32).toString("hex"), ADMINISTRATION: "0", BASE_PATH: "", APP_NAME: "Webmail" });
  await ready("http://127.0.0.1:8080/api/health");
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    const context = await browser.newContext({ viewport });
    const page = active = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const prefix = viewport.width < 769 ? "mobile" : "desktop";
    await page.goto("http://127.0.0.1:8080", { waitUntil: "domcontentloaded" });
    await visible(page, ".gmail-login");
    console.log("UI " + prefix + ": sign-in loaded");
    if (prefix === "mobile") await page.evaluate(() => { document.documentElement.dataset.nativeApp = "true"; });
    await noOverflow(page);
    for (const selector of ["#u", "#p", "button[type=submit]", "#login-language"]) await fits(page, selector);
    await page.screenshot({ path: "ui-smoke/" + prefix + "-login.png", fullPage: true });
    await page.locator("#u").fill("demo");
    await page.locator("#p").fill("demo");
    await page.locator("button[type=submit]").click();
    await visible(page, ".workspace-app");
    await visible(page, ".msg-row");
    console.log("UI " + prefix + ": demo inbox loaded");
    if (prefix === "mobile") await page.locator(".topbar > button").first().click();
    await visible(page, '.mail-navigation a[href*="is%3Astarred"]');
    await visible(page, '.mail-navigation a[href*="in%3Aall"]');
    await visible(page, '.mail-navigation a[href="/settings/labels"]');
    await noOverflow(page);
    await page.screenshot({ path: "ui-smoke/" + prefix + "-navigation.png", fullPage: true });
    if (prefix === "mobile") await page.locator(".drawer-head button").first().click();
    await page.locator('button[aria-controls="advanced-search-panel"]').click();
    await visible(page, "#advanced-search-panel");
    await fits(page, "#advanced-search-panel");
    await page.screenshot({ path: "ui-smoke/" + prefix + "-search.png", fullPage: true });
    await page.locator('button[aria-controls="advanced-search-panel"]').click();
    await page.locator(prefix === "mobile" ? ".fab" : ".compose-btn").click();
    await visible(page, ".composer");
    await fits(page, ".composer");
    await noOverflow(page);
    await page.screenshot({ path: "ui-smoke/" + prefix + "-compose.png", fullPage: true });
    if (errors.length) throw new Error(errors.join("; "));
    report.cases.push({ viewport, login: true, demoMailbox: true, navigation: true, advancedSearch: true, compose: true, noHorizontalOverflow: true });
    await context.close();
  }
} catch (error) {
  report.error = error.message;
  try { report.body = (await active?.locator("body").innerText())?.slice(0,2000); writeFileSync("ui-smoke/failure.html", await active.content()); } catch { /* preserve error */ }
  process.exitCode = 1;
  try { await active?.screenshot({ path: "ui-smoke/failure.png", fullPage: true }); } catch { /* keep failure */ }
} finally {
  writeFileSync("ui-smoke/report.json", JSON.stringify(report, null, 2));
  for (let i = 0; i < children.length; i++) writeFileSync("ui-smoke/server-" + i + ".log", children[i].output());
  await browser?.close();
  for (const { child } of children) child.kill();
  console.log(JSON.stringify(report));
}
