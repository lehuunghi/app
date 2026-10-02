import { test } from "node:test";
import assert from "node:assert/strict";
import { getState } from "./account.js";
import { registryCapability, type UpstreamSession } from "./upstream.js";

for (const cap of ["urn:stalwart:jmap", "urn:inbuxa:jmap:registry"]) {
  test(`account requests use ${cap} and its primary account`, async (t) => {
    const session = {
      capabilities: {}, accounts: {}, primaryAccounts: { [cap]: "registry-account" },
      apiUrl: "https://example.test/jmap", baseUrl: "https://example.test",
    } as UpstreamSession;
    assert.equal(registryCapability(session), cap);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      assert.deepEqual(body.using, ["urn:ietf:params:jmap:core", cap]);
      for (const [, args] of body.methodCalls) assert.equal(args.accountId, "registry-account");
      calls++;
      return new Response(JSON.stringify({ methodResponses: body.methodCalls.map(([name, , id]: [string, unknown, string]) => [name, { list: [] }, id]) }));
    });
    await getState({ authorization: "Basic test", session, username: "test" });
    assert.ok(calls > 0);
  });
}
