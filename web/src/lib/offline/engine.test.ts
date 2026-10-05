import { beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import type { Email, Invocation, JmapResponse, JmapSession, Mailbox } from "@/jmap/types";
import { OfflineEngine } from "./engine";
import { MemoryOfflineStorage } from "./storage";
import type { OfflineOperation, OfflineTransport } from "./types";

const session = { username: "reader@example.test", capabilities: { "urn:ietf:params:jmap:core": {}, "urn:ietf:params:jmap:mail": {}, "urn:ietf:params:jmap:submission": {} },
  accounts: { a: { name: "Reader", isPersonal: true, isReadOnly: false, accountCapabilities: {} } }, primaryAccounts: { "urn:ietf:params:jmap:mail": "a" }, state: "session-1",
  apiUrl: "", downloadUrl: "", uploadUrl: "", eventSourceUrl: "", ihasmail: { remember: true, offlineSync: 1, loginName: "reader@example.test", sessionId: "s", appName: "Webmail", imageProxy: false, maxUploadBytes: 50_000_000 } } as JmapSession;
const boxes = [{ id: "inbox", name: "Inbox", role: "inbox", parentId: null, isSubscribed: true, totalEmails: 1, unreadEmails: 1 }, { id: "trash", name: "Trash", role: "trash", parentId: null, isSubscribed: true }] as Mailbox[];
const email = (id = "e1"): Email => ({ id, blobId: `raw-${id}`, threadId: `t-${id}`, mailboxIds: { inbox: true }, keywords: {}, from: [{ name: "Sender", email: "sender@example.test" }], to: [], subject: "Offline mail", preview: "Persist me", receivedAt: new Date().toISOString(), sentAt: null, size: 100, hasAttachment: true,
  bodyValues: { text: { value: "Persist me", isEncodingProblem: false, isTruncated: false } }, textBody: [{ partId: "text", type: "text/plain", size: 10, blobId: "body", charset: "utf-8", name: null, disposition: null, cid: null }], htmlBody: [], attachments: [{ partId: "att", name: "a.txt", type: "text/plain", size: 5, blobId: "attachment", charset: "utf-8", disposition: "attachment", cid: null }] } as Email);
function fakeServer() {
  const emails = new Map<string, Email>([["e1", email()]]);
  let state = "S1", next = 1, failChanges = false;
  const request = vi.fn(async (body: OfflineOperation["request"]): Promise<JmapResponse> => {
    const responses: Invocation[] = [];
    for (const [name, args, id] of body.methodCalls) {
      let result: Record<string, unknown>;
      if (name === "Mailbox/get") result = { accountId: "a", state: "M1", list: boxes, notFound: [] };
      else if (name === "Email/query") result = { accountId: "a", queryState: state, ids: [...emails.keys()].slice(Number(args.position ?? 0), Number(args.position ?? 0) + Number(args.limit ?? 100)), position: args.position ?? 0 };
      else if (name === "Email/get") {
        const ids = args.ids as string[];
        const full = Boolean(args.fetchTextBodyValues || args.fetchHTMLBodyValues);
        result = { accountId: "a", state, list: ids.flatMap((id) => {
          const e = emails.get(id); if (!e) return [];
          return [full ? e : Object.fromEntries(Object.entries(e).filter(([key]) => (args.properties as string[]).includes(key)))];
        }), notFound: ids.filter((id) => !emails.has(id)) };
      } else if (name === "Email/changes") {
        if (failChanges) { responses.push(["error", { type: "cannotCalculateChanges" }, id]); continue; }
        result = { accountId: "a", oldState: args.sinceState, newState: state, hasMoreChanges: false, created: [], updated: state === args.sinceState ? [] : [...emails.keys()], destroyed: [] };
      } else throw new Error(`Unexpected ${name}`);
      responses.push([name, result, id]);
    }
    return { methodResponses: responses, sessionState: "session-1" };
  });
  const operation = vi.fn(async (_op: OfflineOperation, body: OfflineOperation["request"]): Promise<JmapResponse> => {
    const responses: Invocation[] = [], creations: Record<string, string> = {};
    for (const [name, args, call] of body.methodCalls) {
      const created: Record<string, { id: string }> = {};
      if (name === "Email/set") {
        for (const [key, value] of Object.entries((args.create ?? {}) as Record<string, object>)) {
          const id = `server-${next++}`; creations[key] = id; created[key] = { id };
          emails.set(id, { ...email(id), ...value, id } as Email);
        }
        for (const id of (args.destroy ?? []) as string[]) emails.delete(id);
        for (const [id, patch] of Object.entries((args.update ?? {}) as Record<string, Record<string, unknown>>)) {
          const e = emails.get(id)!;
          for (const [path, value] of Object.entries(patch)) {
            if (path === "mailboxIds") e.mailboxIds = value as Record<string, boolean>;
            else if (path.startsWith("keywords/")) { const key = path.slice(9); if (value) e.keywords[key] = true; else delete e.keywords[key]; }
          }
        }
      } else if (name === "EmailSubmission/set") {
        for (const [key, value] of Object.entries((args.create ?? {}) as Record<string, { emailId: string }>)) {
          const id = value.emailId.startsWith("#") ? creations[value.emailId.slice(1)]! : value.emailId;
          expect(emails.has(id)).toBe(true);
          created[key] = { id: `submission-${next++}` };
        }
      }
      responses.push([name, { accountId: "a", oldState: state, newState: `S${++next}`, created }, call]);
    }
    state = `S${next}`;
    return { methodResponses: responses, sessionState: "session-1" };
  });
  const blob = vi.fn(async () => new Blob(["file"], { type: "text/plain" }));
  const upload = vi.fn(async (_account: string, blob: Blob) => ({ accountId: "a", blobId: "uploaded-1", type: blob.type, size: blob.size }));
  const transport: OfflineTransport = { request, operation, blob, upload };
  return { emails, transport, request, operation, blob, upload, change: () => { state = `S${++next}`; }, stale: () => { failChanges = true; } };
}
const body = (methodCalls: Invocation[]) => ({ using: Object.keys(session.capabilities), methodCalls });

beforeEach(() => { vi.stubGlobal("crypto", webcrypto); });
describe("durable offline mail", () => {
  it("downloads bodies and attachments once, then reads them after app restart without network", async () => {
    const disk = new MemoryOfflineStorage(), server = fakeServer(), engine = new OfflineEngine(disk, server.transport);
    await engine.activate(session); await engine.sync();
    expect(engine.status.complete).toBe(1);
    expect(server.blob).toHaveBeenCalledTimes(2);
    await engine.sync();
    expect(server.blob).toHaveBeenCalledTimes(2);
    const rebooted = new OfflineEngine(disk, server.transport);
    await rebooted.restore();
    server.request.mockClear();
    const result = await rebooted.request(body([["Email/get", { accountId: "a", ids: ["e1"], fetchTextBodyValues: true }, "g"]]));
    expect((result.methodResponses[0]![1].list as Email[])[0]?.bodyValues?.text?.value).toBe("Persist me");
    expect((await rebooted.blob("attachment"))?.size).toBe(4);
    expect(server.request).not.toHaveBeenCalled();
  });
  it("keeps read/star/move intent across restart and flushes it when reconnected", async () => {
    const disk = new MemoryOfflineStorage(), server = fakeServer(), engine = new OfflineEngine(disk, server.transport);
    await engine.activate(session); await engine.sync(); engine.setOnline(false);
    await engine.request(body([["Email/set", { accountId: "a", update: { e1: { "keywords/$seen": true, "keywords/$flagged": true, mailboxIds: { trash: true } } } }, "set"]]));
    expect(server.operation).not.toHaveBeenCalled();
    const rebooted = new OfflineEngine(disk, server.transport); await rebooted.restore();
    const result = await rebooted.request(body([["Email/query", { accountId: "a", filter: { inMailbox: "inbox" } }, "q"]]));
    expect(result.methodResponses[0]![1].ids).toEqual([]);
    expect(rebooted.status.pending).toBe(1);
    await rebooted.sync();
    expect(server.emails.get("e1")?.keywords.$seen).toBe(true);
    expect(server.emails.get("e1")?.mailboxIds).toEqual({ trash: true });
    expect(rebooted.status.pending).toBe(0);
  });
  it("keeps an offline deletion hidden while an uncertain server response is reconciled", async () => {
    const disk = new MemoryOfflineStorage(), server = fakeServer(), engine = new OfflineEngine(disk, server.transport);
    await engine.activate(session); await engine.sync(); engine.setOnline(false);
    await engine.request(body([["Email/set", { accountId: "a", destroy: ["e1"] }, "delete"]]));
    server.operation.mockRejectedValue(Object.assign(new Error(), { code: "operation_uncertain", status: 409 }));
    server.change(); await engine.sync();
    expect(engine.status.cached).toBe(0);
    expect(engine.status.issues).toBe(1);
    const result = await engine.request(body([["Email/get", { accountId: "a", ids: ["e1"], fetchTextBodyValues: true }, "g"]]));
    expect(result.methodResponses[0]![1].list).toEqual([]);
  });
  it("persists a send with offline attachments and preserves the same operation id on retry", async () => {
    const disk = new MemoryOfflineStorage(), server = fakeServer(), engine = new OfflineEngine(disk, server.transport);
    await engine.activate(session); await engine.sync(); engine.setOnline(false);
    const uploaded = await engine.upload(new Blob(["draft attachment"], { type: "text/plain" }));
    const request = body([["Email/set", { accountId: "a", create: { m: { subject: "Send later", mailboxIds: { inbox: true }, keywords: { $draft: true }, bodyValues: { text: { value: "Body" } }, textBody: [], htmlBody: [], attachments: [{ blobId: uploaded.blobId, type: uploaded.type }] } } }, "e"], ["EmailSubmission/set", { accountId: "a", create: { s: { emailId: "#m", identityId: "identity" } } }, "s"]]);
    const result = await engine.request(request);
    const operationId = String(result.methodResponses[1]![1].__offlineQueued);
    expect(engine.status.pending).toBe(1);
    const rebooted = new OfflineEngine(disk, server.transport); await rebooted.restore();
    expect(rebooted.manifest?.operations[0]?.id).toBe(operationId);
    await rebooted.sync();
    expect(server.upload).toHaveBeenCalledTimes(1);
    expect(server.operation).toHaveBeenCalledWith(expect.objectContaining({ id: operationId }), expect.objectContaining({ methodCalls: expect.any(Array) }));
    expect(JSON.stringify(server.operation.mock.calls[0]?.[1])).toContain("uploaded-1");
    expect(rebooted.status.pending).toBe(0);
  });
  it("does not advance UI state when the durable queue write fails", async () => {
    const disk = new MemoryOfflineStorage(), server = fakeServer(), engine = new OfflineEngine(disk, server.transport);
    await engine.activate(session); await engine.sync();
    vi.spyOn(disk, "commit").mockRejectedValueOnce(new Error("disk full"));
    await expect(engine.request(body([["Email/set", { accountId: "a", update: { e1: { "keywords/$seen": true } } }, "set"]]))).rejects.toThrow("disk full");
    expect(engine.status.pending).toBe(0);
    const result = await engine.request(body([["Email/get", { accountId: "a", ids: ["e1"], fetchTextBodyValues: true }, "g"]]));
    expect((result.methodResponses[0]![1].list as Email[])[0]?.keywords.$seen).toBeUndefined();
  });
  it("reconciles destroyed cached messages after a stale cursor and clears data on logout", async () => {
    const disk = new MemoryOfflineStorage(), server = fakeServer(), engine = new OfflineEngine(disk, server.transport);
    await engine.activate(session); await engine.sync(); server.emails.delete("e1"); server.stale();
    await engine.sync(); expect(engine.status.cached).toBe(0);
    await engine.clear();
    const rebooted = new OfflineEngine(disk, server.transport); expect(await rebooted.restore()).toBeNull();
  });
  it("preserves the undo deadline and encrypted composer record across restart", async () => {
    const disk = new MemoryOfflineStorage(), server = fakeServer(), engine = new OfflineEngine(disk, server.transport);
    await engine.activate(session); await engine.sync();
    await engine.writeEditors({ drafts: [{ subject: "Unfinished" }] });
    await engine.request(body([["Email/set", { accountId: "a", update: { e1: { "keywords/$seen": true } } }, "set"]]), { readyAt: Date.now() + 60000 });
    const rebooted = new OfflineEngine(disk, server.transport); await rebooted.restore(); await rebooted.sync();
    expect(server.operation).not.toHaveBeenCalled();
    expect(await rebooted.readEditors()).toEqual({ drafts: [{ subject: "Unfinished" }] });
    await rebooted.cancel(rebooted.manifest!.operations[0]!.id); expect(rebooted.status.pending).toBe(0);
  });
  it("blocks automatic restore after an observed 401 but keeps pending work for reauthentication", async () => {
    const disk = new MemoryOfflineStorage(), server = fakeServer(), engine = new OfflineEngine(disk, server.transport);
    await engine.activate(session); await engine.sync();
    await engine.request(body([["Email/set", { accountId: "a", update: { e1: { "keywords/$flagged": true } } }, "set"]]));
    const id = engine.manifest!.operations[0]!.id;
    await engine.expire(); const rebooted = new OfflineEngine(disk, server.transport);
    expect(await rebooted.restore()).toBeNull(); await rebooted.activate(session);
    expect(rebooted.manifest!.operations[0]!.id).toBe(id);
  });
  it("reconciles an uncertain action using its original UUID", async () => {
    const disk = new MemoryOfflineStorage(), server = fakeServer(), engine = new OfflineEngine(disk, server.transport);
    await engine.activate(session); await engine.sync();
    await engine.request(body([["Email/set", { accountId: "a", update: { e1: { "keywords/$seen": true } } }, "set"]]));
    server.operation.mockRejectedValueOnce(Object.assign(new Error(), { status: 409, code: "operation_uncertain" }));
    await engine.sync(); expect(engine.status.issues).toBe(1); await engine.sync();
    expect(server.operation.mock.calls[0]![0].id).toBe(server.operation.mock.calls[1]![0].id); expect(engine.status.issues).toBe(0);
  });
  it("retains an unsent message in local Outbox when submission alone is rejected", async () => {
    const disk = new MemoryOfflineStorage(), server = fakeServer(), engine = new OfflineEngine(disk, server.transport);
    await engine.activate(session); await engine.sync();
    const result = await engine.request(body([["Email/set", { accountId: "a", create: { m: { subject: "Unsent", mailboxIds: { inbox: true }, bodyStructure: { partId: "text", type: "text/plain" }, bodyValues: { text: { value: "offline: literal content" } } } } }, "e"], ["EmailSubmission/set", { accountId: "a", create: { s: { emailId: "#m", identityId: "identity" } } }, "s"]]));
    const id = (result.methodResponses[0]![1].created as Record<string, { id: string }>).m!.id;
    server.operation.mockResolvedValueOnce({ sessionState: "s", methodResponses: [["Email/set", { created: { m: { id: "real" } } }, "e"], ["EmailSubmission/set", { notCreated: { s: { type: "forbidden" } } }, "s"]] });
    await engine.sync();
    const query = await engine.request(body([["Email/query", { accountId: "a", filter: { inMailbox: "offline:outbox" } }, "q"]]));
    expect(query.methodResponses[0]![1].ids).toContain(id);
    const stored = await engine.request(body([["Email/get", { accountId: "a", ids: [id], fetchTextBodyValues: true }, "g"]]));
    expect((stored.methodResponses[0]![1].list as Email[])[0]!.textBody?.[0]?.partId).toBe("text");
    await engine.sync(); expect(server.operation).toHaveBeenCalledTimes(1);
  });
  it("keeps a downloaded body when an attachment fails, then resumes without fetching the body again", async () => {
    const disk = new MemoryOfflineStorage(), server = fakeServer(), engine = new OfflineEngine(disk, server.transport);
    await engine.activate(session);
    server.blob.mockRejectedValueOnce(Object.assign(new Error(), { status: 0, code: "network_error" }));
    await engine.sync(); expect(engine.status.complete).toBe(0);
    await engine.sync(); expect(engine.status.complete).toBe(1);
    expect(server.request.mock.calls.filter(([b]) => b.methodCalls.some(([n, a]) => n === "Email/get" && a.fetchTextBodyValues))).toHaveLength(1);
  });
});
