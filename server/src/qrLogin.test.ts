import { test } from "node:test";
import assert from "node:assert/strict";
import { QrLogins, QR_TTL } from "./qrLogin.js";
process.env.STALWART_URL = "http://127.0.0.1:1";
const { createApp, sessions } = await import("./app.js");
const { config } = await import("./config.js");
const headers = { "content-type": "application/json", "x-requested-with": "ihasmail" };
const cookies = (response: Response) => (response.headers.get("set-cookie") ?? "").split(";")[0]!;
const request = (app: ReturnType<typeof createApp>, action: string, id?: string, cookie = "") => app.request("http://localhost/api/auth/qr/" + action, { method: "POST", headers: { ...headers, cookie, "user-agent": "Test browser" }, body: JSON.stringify({ id }) });

test("QR expires, binds the private browser secret and rejects a second account", () => {
  let now = 10; const store = new QrLogins(() => now);
  const row = store.create("browser", "browser agent", "ip");
  assert.equal(store.browser(row.id, "other"), null);
  assert.equal(store.browser(row.id, undefined), null);
  assert.equal(store.approve(row.id, "phone", "secret"), true);
  assert.equal(store.approve(row.id, "attacker", "other"), false);
  now += QR_TTL; assert.equal(store.get(row.id), null);
});
test("QR capacity, cancellation and malformed identifiers are bounded", () => {
  const store = new QrLogins(Date.now, 1); const row = store.create("b", "ua", "ip");
  assert.throws(() => store.create("c", "ua", "ip"));
  store.cancel(row.id, "other"); assert.ok(store.get(row.id));
  store.cancel(row.id, "b"); assert.equal(store.get(row.id), null);
  assert.equal(store.get({}), null); assert.ok(store.create("b", "ua", "ip"));
});
test("QR requires CSRF, HTTPS away from localhost and an authenticated approving device", async () => {
  const app = createApp();
  assert.equal((await app.request("http://localhost/api/auth/qr/create", { method: "POST" })).status, 403);
  assert.equal((await app.request("http://insecure.example/api/auth/qr/create", { method: "POST", headers, body: "{}" })).status, 400);
  const created = await request(app, "create"); const row = await created.json();
  assert.match(created.headers.get("cache-control")!, /no-store/);
  assert.match(created.headers.get("set-cookie")!, /HttpOnly/);
  assert.equal((await request(app, "poll", row.id)).status, 410);
  assert.equal((await request(app, "approve", row.id)).status, 401);
  assert.deepEqual(await (await request(app, "poll", row.id, cookies(created))).json(), { status: "pending" });
});
test("QR grants a separate browser session, retry is idempotent, source logout blocks pending grants", async (t) => {
  const real = globalThis.fetch; t.after(() => { globalThis.fetch = real; });
  globalThis.fetch = (async () => Response.json({ apiUrl: "http://localhost/jmap", username: "demo", capabilities: { "urn:stalwart:jmap": {} }, accounts: {}, primaryAccounts: {} })) as typeof fetch;
  const app = createApp();
  const phone = sessions.create({ username: "demo", password: "p:a:ss", remember: true, userAgent: "phone", ip: "phone-ip" });
  t.after(() => sessions.destroyAllForUser(phone.session.account));
  const phoneCookie = config.cookieName + "=" + phone.cookie;
  const created = await request(app, "create"); const row = await created.json(); const browserCookie = cookies(created);
  const inspected = await request(app, "inspect", row.id, phoneCookie); assert.equal(inspected.status, 200); assert.equal((await inspected.json()).code, row.code);
  assert.equal((await request(app, "approve", row.id, phoneCookie)).status, 200);
  assert.equal((await request(app, "poll", row.id, "wrong=secret")).status, 410);
  const result = await request(app, "poll", row.id, browserCookie); assert.equal(result.status, 200); assert.deepEqual(await result.json(), { status: "approved" });
  const issuedCookie = decodeURIComponent(cookies(result).split("=").slice(1).join("="));
  const issued = sessions.resolve(issuedCookie)!; assert.notEqual(issued.id, phone.session.id); assert.equal(issued.authorization, phone.session.authorization);
  const replay = await request(app, "poll", row.id, browserCookie); assert.equal(cookies(replay), cookies(result));
  const created2 = await request(app, "create"); const row2 = await created2.json();
  await request(app, "approve", row2.id, phoneCookie); sessions.destroy(phone.session.id);
  assert.equal((await request(app, "poll", row2.id, cookies(created2))).status, 410);
  const cancelled = await request(app, "create"); const row3 = await cancelled.json();
  await request(app, "cancel", row3.id, cookies(cancelled)); assert.equal((await request(app, "poll", row3.id, cookies(cancelled))).status, 410);
});
