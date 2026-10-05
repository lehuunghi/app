import { test } from "node:test";
import assert from "node:assert/strict";
import { pullOffline, validatePull, type PullInput } from "./offlinePull.js";
import type { OfflineRequest, OfflineResponse } from "./offlineOperations.js";
const input: PullInput = { accountId: "a", sinceState: "old", knownIds: ["older", "deleted"], historyDays: 30, maxMessages: 1000 };
test("native pull validates personal accounts and bounded snapshots", () => {
  assert.throws(() => validatePull(input, { a: { isPersonal: false } }), { code: "bad_request" });
  assert.throws(() => validatePull({ ...input, snapshot: { state: "s", position: -1 } }, { a: { isPersonal: true } }), { code: "bad_request" });
  assert.equal(validatePull(input, { a: { isPersonal: true } }).accountId, "a");
});
test("native pull returns a delta cursor with its changed and destroyed ids", async () => {
  const invoke = async (request: OfflineRequest): Promise<OfflineResponse> => {
    const [name] = request.methodCalls[0]!;
    const args = name === "Email/changes" ? { newState: "new", created: ["mail"], updated: [], destroyed: ["deleted"], hasMoreChanges: false } : name === "Email/get" ? { list: [{ id: "mail" }], notFound: [] } : { list: [], state: "m" };
    return { sessionState: "s", methodResponses: [[name, args, "pull"]] };
  };
  const result = await pullOffline(input, invoke);
  assert.equal(result.state, "new"); assert.deepEqual(result.removed, ["deleted"]); assert.deepEqual(result.list, [{ id: "mail" }]);
});
test("stale native cursor takes a baseline before snapshot and revalidates older downloaded ids", async () => {
  const seen: string[] = [];
  const invoke = async (request: OfflineRequest): Promise<OfflineResponse> => {
    const [name, args] = request.methodCalls[0]!; seen.push(name);
    if (name === "Email/changes") return { sessionState: "s", methodResponses: [["error", { type: "cannotCalculateChanges" }, "pull"]] };
    const result = name === "Email/get" && !(args.ids as string[]).length ? { state: "baseline", list: [], notFound: [] }
      : name === "Email/query" ? { ids: ["recent"] }
      : name === "Email/get" ? { list: (args.ids as string[]).filter((id) => id !== "deleted").map((id) => ({ id })), notFound: (args.ids as string[]).filter((id) => id === "deleted") }
      : { list: [], state: "m" };
    return { sessionState: "s", methodResponses: [[name, result, "pull"]] };
  };
  const result = await pullOffline(input, invoke);
  assert.ok(seen.indexOf("Email/get") < seen.indexOf("Email/query"));
  assert.equal(result.state, "baseline"); assert.deepEqual(result.removed, ["deleted"]); assert.deepEqual(result.list.map((e) => e.id), ["recent", "older"]);
});
