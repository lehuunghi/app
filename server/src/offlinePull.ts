import { OfflineOperationError, type OfflineRequest, type OfflineResponse } from "./offlineOperations.js";
const CORE = "urn:ietf:params:jmap:core", MAIL = "urn:ietf:params:jmap:mail";
export const OFFLINE_LIST_PROPS = ["id", "blobId", "threadId", "mailboxIds", "keywords", "hasAttachment", "from", "to", "subject", "receivedAt", "sentAt", "size", "preview"];
type Json = Record<string, unknown>;
export interface PullInput { accountId: string; sinceState?: string | null; knownIds: string[]; historyDays: number; maxMessages: number; snapshot?: { state: string; position: number } }
export function validatePull(value: unknown, accounts: Record<string, unknown>): PullInput {
  const v = value as PullInput;
  if (!v || typeof v !== "object" || typeof v.accountId !== "string" || !Object.hasOwn(accounts, v.accountId) || !(accounts[v.accountId] as { isPersonal?: boolean }).isPersonal
    || !Array.isArray(v.knownIds) || v.knownIds.length > 10000 || v.knownIds.some((id) => typeof id !== "string" || id.length > 512)
    || ![7, 30, 90, 365].includes(v.historyDays) || !Number.isInteger(v.maxMessages) || v.maxMessages < 1 || v.maxMessages > 1000
    || v.sinceState != null && (typeof v.sinceState !== "string" || v.sinceState.length > 512)
    || v.snapshot != null && (typeof v.snapshot.state !== "string" || v.snapshot.state.length > 512 || !Number.isInteger(v.snapshot.position) || v.snapshot.position < 0 || v.snapshot.position > v.maxMessages)) throw new OfflineOperationError("bad_request", 400);
  return v;
}
/** Stateless native delta protocol. The client commits the returned cursor WITH the metadata. */
export async function pullOffline(input: PullInput, invoke: (request: OfflineRequest) => Promise<OfflineResponse>) {
  const call = async (name: string, args: Json): Promise<Json> => {
    const response = await invoke({ using: [CORE, MAIL], methodCalls: [[name, { accountId: input.accountId, ...args }, "pull"]] });
    const found = response.methodResponses.find((r) => r[2] === "pull");
    if (!found || found[0] === "error") throw new OfflineOperationError(String(found?.[1].type ?? "invalid_upstream_response"));
    return found[1];
  };
  const boxes = await call("Mailbox/get", { ids: null });
  const identities = await call("Identity/get", { ids: null });
  let list: Json[] = [], removed: string[] = [], state = input.sinceState ?? null, more = false;
  let snapshot = input.snapshot;
  if (state && !snapshot) {
    try {
      const delta = await call("Email/changes", { sinceState: state, maxChanges: 100 });
      const ids = [...new Set([...(delta.created as string[]), ...(delta.updated as string[])])];
      removed = delta.destroyed as string[];
      if (ids.length) { const got = await call("Email/get", { ids, properties: OFFLINE_LIST_PROPS }); list = got.list as Json[]; removed.push(...got.notFound as string[]); }
      state = String(delta.newState); more = Boolean(delta.hasMoreChanges);
    } catch (e) { if (!(e instanceof OfflineOperationError) || e.code !== "cannotCalculateChanges") throw e; state = null; }
  }
  if (!state || snapshot) {
    if (!snapshot) { const baseline = await call("Email/get", { ids: [], properties: ["id"] }); snapshot = { state: String(baseline.state), position: 0 }; }
    const limit = Math.min(100, input.maxMessages - snapshot.position);
    const q = limit > 0 ? await call("Email/query", { filter: { after: new Date(Date.now() - input.historyDays * 86400000).toISOString() }, sort: [{ property: "receivedAt", isAscending: false }], position: snapshot.position, limit }) : { ids: [] };
    const ids = q.ids as string[];
    if (ids.length) { const got = await call("Email/get", { ids, properties: OFFLINE_LIST_PROPS }); list = got.list as Json[]; removed.push(...got.notFound as string[]); }
    snapshot.position += ids.length;
    more = ids.length === limit && snapshot.position < input.maxMessages;
    if (!more) {
      // A stale cursor must not retain deleted older messages indefinitely.
      for (let i = 0; i < input.knownIds.length; i += 100) {
        const got = await call("Email/get", { ids: input.knownIds.slice(i, i + 100), properties: OFFLINE_LIST_PROPS });
        list.push(...got.list as Json[]); removed.push(...got.notFound as string[]);
      }
      state = snapshot.state; snapshot = undefined;
    } else state = null;
  }
  return { state, snapshot: snapshot ?? null, more, list: [...new Map(list.map((e) => [e.id, e])).values()], removed: [...new Set(removed)], mailboxes: boxes.list, mailboxState: boxes.state, identities: identities.list };
}
