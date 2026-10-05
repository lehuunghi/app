import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { OfflineOperationJournal, validateOfflineRequest, reconcileOfflineSend, OP_HEADER, type OfflineRequest } from "./offlineOperations.js";

test("operation acknowledgement survives restart and stored payload is encrypted", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "offline-journal-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const id = randomUUID(); let dispatches = 0;
  const journal = new OfflineOperationJournal(dir, "stable-secret");
  const payload = { subject: "confidential-message", nested: { b: 1, a: 2 } }, result = { accepted: true, private: "sensitive-result" };
  assert.deepEqual(await journal.execute("user/account", id, payload, async (mark) => { await mark(); dispatches++; return result; }), result);
  const rebooted = new OfflineOperationJournal(dir, "stable-secret");
  assert.deepEqual(await rebooted.execute("user/account", id, { nested: { a: 2, b: 1 }, subject: "confidential-message" }, async () => { dispatches++; return result; }), result);
  assert.equal(dispatches, 1);
  const bytes = await readFile(join(dir, (await readdir(dir))[0]!));
  assert.equal(bytes.includes(Buffer.from("sensitive-result")), false);
  await assert.rejects(rebooted.execute("user/account", id, { subject: "changed" }, async () => result), { code: "operation_id_reused" });
});
test("an unknown send outcome is never dispatched again, then a confirmed receipt resolves it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "offline-journal-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const id = randomUUID(), payload = { send: true }; let calls = 0;
  const journal = new OfflineOperationJournal(dir, "stable");
  await assert.rejects(journal.execute("u/a", id, payload, async (mark) => { await mark(); calls++; throw new Error("lost response"); }), { code: "operation_uncertain" });
  const rebooted = new OfflineOperationJournal(dir, "stable");
  await assert.rejects(rebooted.execute("u/a", id, payload, async () => { calls++; return "bad"; }, async () => null), { code: "operation_uncertain" });
  assert.equal(calls, 1);
  assert.equal(await rebooted.execute("u/a", id, payload, async () => "bad", async () => "confirmed"), "confirmed");
});
test("failures before dispatch may retry, while concurrent requests never dispatch twice", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "offline-journal-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const journal = new OfflineOperationJournal(dir, "stable"), id = randomUUID();
  await assert.rejects(journal.execute("u/a", id, {}, async () => { throw new Error("preflight unavailable"); }));
  let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void; const began = new Promise<void>((resolve) => { started = resolve; }); let calls = 0;
  const first = journal.execute("u/a", id, {}, async (mark) => { await mark(); calls++; started(); await wait; return "ok"; });
  await began;
  await assert.rejects(journal.execute("u/a", id, {}, async () => { calls++; return "duplicate"; }), { code: "operation_in_progress" });
  release(); assert.equal(await first, "ok"); assert.equal(calls, 1);
});
test("offline endpoint rejects administration, foreign accounts and mixed accounts", () => {
  assert.throws(() => validateOfflineRequest({ using: [], methodCalls: [["x:Account/set", { accountId: "a" }, "c"]] }, { a: {} }), { code: "bad_request" });
  assert.throws(() => validateOfflineRequest({ using: [], methodCalls: [["Email/set", { accountId: "foreign" }, "c"]] }, { a: {} }), { code: "account_not_found" });
  assert.throws(() => validateOfflineRequest({ using: [], methodCalls: [["Email/set", { accountId: "a" }, "c"], ["Mailbox/set", { accountId: "b" }, "d"]] }, { a: {}, b: {} }), { code: "mixed_accounts" });
});
test("send reconciliation requires a positive submission and preserves original creation references", async () => {
  const id = randomUUID(), body: OfflineRequest = { using: [], methodCalls: [["Email/set", { accountId: "a", create: { m: {} } }, "e"], ["EmailSubmission/set", { accountId: "a", create: { s: { emailId: "#m" } } }, "s"]] };
  const invoke = async (request: OfflineRequest) => ({ sessionState: "s", methodResponses: request.methodCalls[0]![0] === "Email/query"
    ? [["Email/query", { ids: ["mail-id"] }, "lookup"]] : [["Email/get", { list: [{ id: "mail-id", [OP_HEADER]: `${id}/e/m` }] }, "emails"], ["EmailSubmission/query", { ids: ["submission-id"] }, "submissions"]] }) as never;
  const result = await reconcileOfflineSend(body, id, invoke);
  assert.deepEqual(result?.methodResponses[0]?.[1].created, { m: { id: "mail-id" } });
  assert.deepEqual(result?.methodResponses[1]?.[1].created, { s: { id: "submission-id" } });
});
