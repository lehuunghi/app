/** Browser integration with a native-storage bridge stub and real mock-server API. */
export async function offlineUiSmoke(browser) {
  const rows = new Map();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  let offline = false;
  const result = { nativeBridge: "storage stub; encryption is checked by native simulator tests" };
  try {
    await context.exposeBinding("offlineTestNative", async (_, plugin, method, args = {}) => {
      if (plugin !== "OfflineMailStore") {
        if (plugin === "App" && method === "getState") return { isActive: true };
        if (method === "checkPermissions") return { display: "denied", receive: "denied" };
        if (method === "readdir") return { files: [] };
        return {};
      }
      const key = args.scope + "\0" + args.key;
      if (method === "read") return { value: rows.get(key) ?? null };
      if (method === "list") return { values: Object.fromEntries([...rows].filter(([k]) => k.startsWith(args.scope + "\0" + args.prefix)).map(([k, v]) => [k.slice(args.scope.length + 1), v])) };
      if (method === "commit") { for (const c of args.changes) { const k = args.scope + "\0" + c.key; if (c.value == null) rows.delete(k); else rows.set(k, c.value); } return {}; }
      if (method === "bytes") return { bytes: [...rows].filter(([k]) => k.startsWith(args.scope + "\0")).reduce((n, [, v]) => n + Buffer.byteLength(v), 0) };
      if (method === "clear") rows.clear();
      return {};
    });
    await context.addInitScript(() => {
      window.CapacitorCustomPlatform = { name: "android" };
      const methods = {
        OfflineMailStore: ["read", "list", "commit", "bytes", "clear", "configure", "sync"],
        App: ["getState", "minimizeApp", "removeListener"], Filesystem: ["rmdir", "mkdir", "readdir", "deleteFile", "getUri"],
        PushNotifications: ["removeAllDeliveredNotifications", "unregister", "checkPermissions"],
        LocalNotifications: ["checkPermissions", "createChannel", "cancelAll", "removeAllDeliveredNotifications"],
        CapacitorCookies: ["clearCookies"],
      };
      window.Capacitor = {
        PluginHeaders: Object.entries(methods).map(([name, list]) => ({ name, methods: [...list.map((name) => ({ name, rtype: "promise" })), { name: "addListener", rtype: "callback" }] })),
        nativePromise: (plugin, method, args) => window.offlineTestNative(plugin, method, args),
        nativeCallback: () => "test-listener",
      };
    });
    await context.route("https://webmail.jmail.vn/api/**", async (route) => {
      if (offline) { await route.abort("internetdisconnected"); return; }
      const url = new URL(route.request().url());
      const cors = { "access-control-allow-origin": "http://127.0.0.1:8080", "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type,x-requested-with", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS" };
      if (route.request().method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors }); return; }
      const headers = { ...route.request().headers(), "sec-fetch-site": "none" }; delete headers.origin;
      const response = await route.fetch({ url: "http://127.0.0.1:8080" + url.pathname + url.search, headers });
      await route.fulfill({ response, headers: { ...response.headers(), ...cors } });
    });
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:8080");
    await page.locator("#u").fill("demo"); await page.locator("#p").fill("demo"); await page.locator("button[type=submit]").click();
    await page.locator(".msg-row").first().waitFor({ timeout: 30000 });
    const firstId = await page.locator(".msg-row").first().getAttribute("data-row-id");
    const cachedFirst = () => [...rows].some(([k, v]) => k.endsWith("\0mail:" + firstId) && JSON.parse(v).complete);
    for (let i = 0; i < 120 && !cachedFirst(); i++) await new Promise((resolve) => setTimeout(resolve, 500));
    const downloaded = [...rows].filter(([k, v]) => k.includes("\0mail:") && JSON.parse(v).complete);
    if (!cachedFirst()) throw new Error("Native repository did not download the visible message");
    if (![...rows].some(([k, v]) => k.endsWith("\0manifest") && JSON.parse(v).session.ihasmail.offlineSync === 1)) throw new Error("Native offline protocol was not activated");
    offline = true;
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await page.reload();
    await page.locator(".msg-row").first().waitFor({ timeout: 30000 });
    const cachedRow = page.locator(".msg-row").filter({ has: page.locator(".msg-star") }).filter({ visible: true }).first();
    if (await cachedRow.getAttribute("data-row-id") !== firstId) throw new Error("Cached inbox order changed after offline reload");
    await cachedRow.locator(".msg-star").first().click();
    await cachedRow.click();
    await page.locator(".message-body").first().waitFor({ timeout: 30000 });
    const body = await page.locator(".message-body").first().evaluate((element) => element.innerText + [...element.querySelectorAll(".body-host")].map((host) => host.shadowRoot?.textContent ?? "").join(""));
    if (!body.trim()) throw new Error("Offline cached message rendered empty");
    await page.screenshot({ path: "ui-smoke/mobile-offline-read.png", fullPage: true });
    // Starring creates a durable mutation even when the fixture is already read.
    for (let i = 0; i < 40 && ![...rows].some(([k, v]) => k.endsWith("\0manifest") && JSON.parse(v).operations.length); i++) await new Promise((resolve) => setTimeout(resolve, 500));
    if (![...rows].some(([k, v]) => k.endsWith("\0manifest") && JSON.parse(v).operations.length)) throw new Error("Offline UI mutation was not queued");
    offline = false; await page.evaluate(() => window.dispatchEvent(new Event("online")));
    for (let i = 0; i < 120 && [...rows].some(([k, v]) => k.endsWith("\0manifest") && JSON.parse(v).operations.length); i++) await new Promise((resolve) => setTimeout(resolve, 500));
    if ([...rows].some(([k, v]) => k.endsWith("\0manifest") && JSON.parse(v).operations.length)) throw new Error("Queued UI mutation did not sync");
    return { ...result, cachedMessages: downloaded.length, reloadWithoutAPI: true, bodyRenderedOffline: true, queuedMutation: true, resumedSync: true };
  } finally { await context.close(); }
}
