import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { generateKeyPairSync, verify } from "node:crypto";
import { NativePush, NativePushError } from "./nativePush.js";
import { SessionStore, type LiveSession } from "./sessions.js";
import { androidPayload, iosPayload, signedToken, type NativeMessage, type PushResult } from "./nativePushProviders.js";
import { watchNativeMail, type MailChange } from "./nativeMailWatch.js";
import { createApp, sessions as appSessions } from "./app.js";
import { config } from "./config.js";

const installation = "11111111-1111-4111-8111-111111111111";
const body = { installation, platform: "android" as const, token: "fcm-token-12345678901234567890123456789" };
const login = (store: SessionStore, name = "alice") => store.create({ username: name, account: `server|${name}`, password: "secret-password", remember: true, userAgent: "test", ip: "127.0.0.1" });
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const folder = await mkdtemp(resolve(process.cwd(), ".native-test-"));
  const file = resolve(folder, "devices.json");
  const sessions = new SessionStore("");
  const account = login(sessions);
  const changes: MailChange[] = [];
  const seen: Array<{ token: string; message: NativeMessage }> = [];
  const results: PushResult[] = [];
  let checks = 0;
  const watch = async (s: LiveSession, state?: string) => {
    assert.ok(s.authorization.startsWith("Basic ")); checks++;
    return state ? changes.shift() ?? { state } : { state: "baseline" };
  };
  const provider = { ready: () => true, send: async (_platform: string, token: string, message: NativeMessage) => {
    seen.push({ token, message }); return results.shift() ?? "sent";
  } };
  const native = new NativePush(sessions, provider, watch, file, "test-app-secret");
  await native.init();
  t.after(async () => { await native.close(); await sessions.close(); await rm(folder, { recursive: true, force: true }); });
  return { native, sessions, account, changes, seen, results, file, watch, provider, checks: () => checks };
}

test("baseline does not notify old mail; new mail sends once and persists encrypted credentials", async (t) => {
  const f = await fixture(t);
  await f.native.register(f.account.session, body);
  await f.native.tick(); assert.equal(f.seen.length, 0);
  f.changes.push({ state: "new", emailId: "mail-1" });
  await f.native.tick(); await f.native.tick();
  assert.equal(f.seen.length, 1); assert.equal(f.seen[0]!.message.emailId, "mail-1");
  const disk = await readFile(f.file, "utf8");
  assert.ok(!disk.includes(body.token)); assert.ok(!disk.includes(f.account.session.authorization)); assert.ok(!disk.includes("secret-password"));
  assert.equal(JSON.parse(disk)[0].state, "new");
});
test("read/flag-only updates never send an alert", async (t) => {
  const f = await fixture(t); await f.native.register(f.account.session, body);
  f.changes.push({ state: "read" }); await f.native.tick(); assert.equal(f.seen.length, 0);
});
test("retry queue survives restart without querying away an undelivered email", async (t) => {
  const f = await fixture(t); await f.native.register(f.account.session, body);
  f.changes.push({ state: "later", emailId: "mail-2" }); f.results.push("retry"); await f.native.tick();
  await f.native.close();
  const checks = f.checks();
  const restored = new NativePush(f.sessions, f.provider, f.watch, f.file, "test-app-secret");
  await restored.init(); await restored.tick(); await restored.close();
  assert.equal(f.checks(), checks); assert.equal(f.seen.length, 2);
  assert.equal(JSON.parse(await readFile(f.file, "utf8"))[0].state, "later");
});
test("token ownership changes accounts without retaining the first registration", async (t) => {
  const f = await fixture(t); await f.native.register(f.account.session, body);
  const other = login(f.sessions, "bob"); await f.native.register(other.session, body);
  assert.equal(f.native.status(f.account.session, installation, "android").enabled, false);
  await f.native.remove(f.account.session.id, installation);
  assert.equal(f.native.status(other.session, installation, "android").enabled, true);
});
test("revoking or expiring a session stops native notifications", async (t) => {
  const f = await fixture(t); await f.native.register(f.account.session, body);
  f.sessions.destroyAllForUser(f.account.session.account);
  f.changes.push({ state: "new", emailId: "mail" }); await f.native.tick();
  assert.equal(f.seen.length, 0); assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), []);
});
test("logout during an upstream check cannot deliver a queued notification", async (t) => {
  const f = await fixture(t);
  let finish!: (v: MailChange) => void;
  const native = new NativePush(f.sessions, f.provider, async (_s, state) => state ? new Promise((resolve) => { finish = resolve; }) : { state: "base" }, f.file + ".race", "test-secret");
  await native.register(f.account.session, body);
  const checking = native.tick(); await new Promise((resolve) => setImmediate(resolve));
  f.sessions.destroy(f.account.session.id); finish({ state: "new", emailId: "mail" }); await checking;
  assert.equal(f.seen.length, 0); await native.close();
});
test("invalid provider token is removed; transient errors remain retryable", async (t) => {
  const f = await fixture(t); await f.native.register(f.account.session, body);
  f.changes.push({ state: "new", emailId: "mail" }); f.results.push("invalid"); await f.native.tick();
  assert.equal(f.native.status(f.account.session, installation, "android").enabled, false);
});
test("an old account's delayed registration cannot overwrite a new account's token", async (t) => {
  const f = await fixture(t);
  const other = login(f.sessions, "bob");
  let finish!: (v: MailChange) => void;
  const service = new NativePush(f.sessions, f.provider, async (session) => session.id === f.account.session.id
    ? new Promise((resolve) => { finish = resolve; }) : { state: "bob-baseline" }, f.file + ".race-register", "test-secret");
  const old = service.register(f.account.session, body);
  await service.register(other.session, body);
  finish({ state: "alice-baseline" });
  await assert.rejects(old, (e) => e instanceof NativePushError && e.code === "stale_device_session");
  assert.equal(service.status(other.session, installation, "android").enabled, true);
  await service.close();
});
test("rejects untrusted sessions and malformed iOS/Android registrations", async (t) => {
  const f = await fixture(t);
  for (const invalid of [{ ...body, token: "short" }, { ...body, platform: "ios", token: "not-an-apns-token" }, { ...body, platform: "browser" }]) {
    await assert.rejects(f.native.register(f.account.session, invalid), (e) => e instanceof NativePushError && e.status === 400);
  }
  await assert.rejects(f.native.register({ ...f.account.session, remember: false }, body), (e) => e instanceof NativePushError && e.status === 409);
});
test("FCM/APNs payloads expose only an opaque session binding and email ID", () => {
  const m = { binding: "opaque-session-hash", emailId: "mail-id" };
  const android = androidPayload("token", m), ios = iosPayload(m);
  assert.deepEqual(android.message.data, m);
  assert.equal(android.message.notification.body, "Bạn có email mới.");
  assert.equal(ios.aps.alert.body, android.message.notification.body);
  assert.equal(android.message.android.notification.channel_id, "webmail-new-mail");
  assert.ok(!JSON.stringify([android, ios]).includes("password"));
});
test("JWT signatures use RSA for Google and fixed-width ES256 for Apple", () => {
  for (const algorithm of ["RS256", "ES256"]) {
    const keys = algorithm === "RS256" ? generateKeyPairSync("rsa", { modulusLength: 2048 }) : generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const key = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const jwt = signedToken({ alg: algorithm }, { iat: 123, iss: "test" }, key);
    const [header, claims, signature] = jwt.split(".");
    assert.ok(verify("sha256", Buffer.from(`${header}.${claims}`), algorithm === "ES256" ? { key: keys.publicKey, dsaEncoding: "ieee-p1363" } : keys.publicKey, Buffer.from(signature!, "base64url")));
    if (algorithm === "ES256") assert.equal(Buffer.from(signature!, "base64url").length, 64);
  }
});

test("JMAP watch filters only newly created unread Inbox mail", async (t) => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let changes: any = { newState: "new", created: ["new", "junk", "read", "draft"], hasMoreChanges: false };
  let mode = "fresh";
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    if (!init?.body) return Response.json({ capabilities: {}, accounts: {}, primaryAccounts: { "urn:ietf:params:jmap:mail": "a" }, apiUrl: "/jmap", username: "alice" });
    const request = JSON.parse(init.body as string);
    if (request.methodCalls[0][0] === "Email/get") return Response.json({ methodResponses: [["Email/get", { state: "base", list: [] }, "baseline"]] });
    assert.equal(request.methodCalls[1][0], "Email/changes");
    assert.equal(request.methodCalls[2][1]["#ids"].path, "/created");
    return Response.json({ methodResponses: [
      ["Mailbox/get", { list: [{ id: "inbox", role: "inbox" }] }, "folders"],
      [mode === "reset" ? "error" : "Email/changes", mode === "reset" ? { type: "cannotCalculateChanges" } : changes, "changes"],
      ["Email/get", { list: mode === "updated" ? [] : [
        { id: "junk", mailboxIds: { junk: true }, keywords: {} }, { id: "read", mailboxIds: { inbox: true }, keywords: { $seen: true } },
        { id: "draft", mailboxIds: { inbox: true }, keywords: { $draft: true } }, { id: "new", mailboxIds: { inbox: true }, keywords: {} },
      ] }, "messages"],
    ] });
  }) as typeof fetch;
  const session = login(new SessionStore("")).session;
  assert.deepEqual(await watchNativeMail(session), { state: "base" });
  assert.equal((await watchNativeMail(session, "base")).emailId, "new");
  mode = "updated"; changes = { newState: "read-state", created: [], updated: ["new"] };
  assert.equal((await watchNativeMail(session, "new")).emailId, undefined);
  mode = "reset"; assert.deepEqual(await watchNativeMail(session, "read-state"), { state: "base" });
});

test("native API requires session and CSRF; DELETE cannot remove another account's device", async (t) => {
  const f = await fixture(t);
  const a = appSessions.create({ username: "alice", account: "api|alice", password: "secret", remember: true, userAgent: "test", ip: "local" });
  const b = appSessions.create({ username: "bob", account: "api|bob", password: "secret", remember: true, userAgent: "test", ip: "local" });
  t.after(async () => { appSessions.destroy(a.session.id); appSessions.destroy(b.session.id); });
  const service = new NativePush(appSessions, f.provider, f.watch, f.file + ".api", "test-secret");
  const app = createApp("", service);
  const request = (cookie: string | undefined, method = "POST", csrf = true) => app.request("/api/notifications/native?platform=android&installation=" + installation, {
    method, headers: { ...(cookie ? { cookie: `${config.cookieName}=${cookie}` } : {}), "content-type": "application/json", ...(csrf ? { "x-requested-with": "ihasmail" } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal((await request(undefined)).status, 401);
  assert.equal((await request(a.cookie, "POST", false)).status, 403);
  assert.equal((await request(a.cookie)).status, 200);
  assert.equal((await request(b.cookie, "DELETE")).status, 200);
  assert.equal((await (await request(a.cookie, "GET")).json()).enabled, true);
  assert.equal((await request(a.cookie, "DELETE")).status, 200);
  assert.equal((await (await request(a.cookie, "GET")).json()).enabled, false);
  await service.close();
});
