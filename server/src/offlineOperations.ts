import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export class OfflineOperationError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
interface Journal { hash: string; dispatched: boolean; result?: unknown }

/** Durable at-most-once dispatch. Unknown outcomes are reconciled, never blindly replayed. */
export class OfflineOperationJournal {
  private key: Buffer;
  constructor(readonly directory: string, secret: string) {
    this.key = createHash("sha256").update(`webmail-offline-operations-v1\0${secret}`).digest();
  }
  private seal(value: Journal): Buffer {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]);
  }
  private unseal(data: Buffer): Journal {
    const decipher = createDecipheriv("aes-256-gcm", this.key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8")) as Journal;
  }
  private async write(path: string, record: Journal) {
    const temp = `${path}.${randomBytes(12).toString("hex")}.tmp`;
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(this.seal(record)); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, path);
    const dir = await open(this.directory, "r");
    try { await dir.sync(); } finally { await dir.close(); }
  }
  async execute<T>(scope: string, id: string, payload: unknown,
    dispatch: (markDispatched: () => Promise<void>) => Promise<T>, reconcile?: () => Promise<T | null>): Promise<T> {
    if (!this.directory) throw new OfflineOperationError("offline_operations_unavailable", 503);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) throw new OfflineOperationError("bad_operation_id", 400);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const key = createHash("sha256").update(`${scope}\0${id}`).digest("hex"), path = join(this.directory, `${key}.bin`), lock = `${path}.lock`;
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])])) : value;
    const hash = createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
    let previous: Journal | null = null;
    try { previous = this.unseal(await readFile(path)); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new OfflineOperationError("operation_journal_unreadable", 503); }
    if (previous?.hash !== undefined && previous.hash !== hash) throw new OfflineOperationError("operation_id_reused");
    if (previous?.result !== undefined) return previous.result as T;
    let handle;
    try { handle = await open(lock, "wx", 0o600); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Expired lock permits reconciliation only: the dispatch marker still forbids replay.
      const age = Date.now() - (await stat(lock)).mtimeMs;
      if (age < 10 * 60_000) throw new OfflineOperationError("operation_in_progress");
      await rm(lock, { force: true });
      throw new OfflineOperationError("operation_in_progress");
    }
    let dispatched = false;
    try {
      // A peer can finish between the first read and acquiring the file lock.
      try { previous = this.unseal(await readFile(path)); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new OfflineOperationError("operation_journal_unreadable", 503); }
      if (previous?.hash !== undefined && previous.hash !== hash) throw new OfflineOperationError("operation_id_reused");
      if (previous?.result !== undefined) return previous.result as T;
      dispatched = Boolean(previous?.dispatched);
      if (dispatched) {
        const result = await reconcile?.();
        if (result == null) throw new OfflineOperationError("operation_uncertain");
        await this.write(path, { hash, dispatched: true, result });
        return result;
      }
      const result = await dispatch(async () => {
        await this.write(path, { hash, dispatched: true });
        dispatched = true;
      });
      await this.write(path, { hash, dispatched: true, result });
      return result;
    } catch (err) {
      if (err instanceof OfflineOperationError && err.status === 401) {
        // An authenticated API rejection happens before JMAP execution.
        await rm(path, { force: true });
        throw err;
      }
      if (dispatched && !(err instanceof OfflineOperationError)) throw new OfflineOperationError("operation_uncertain");
      throw err;
    } finally { await handle.close(); await rm(lock, { force: true }); }
  }
}

type Invocation = [string, Record<string, unknown>, string];
export interface OfflineRequest { using: string[]; methodCalls: Invocation[]; createdIds?: Record<string, string> }
export interface OfflineResponse { methodResponses: Invocation[]; sessionState: string }
export const OP_HEADER = "header:X-Webmail-Operation-ID:asText";
const allowed = new Set(["Email/set", "Mailbox/set", "EmailSubmission/set"]);
export function validateOfflineRequest(value: unknown, accounts: Record<string, unknown>): OfflineRequest {
  if (!value || typeof value !== "object") throw new OfflineOperationError("bad_request", 400);
  const body = value as OfflineRequest;
  if (!Array.isArray(body.using) || body.using.some((s) => typeof s !== "string") || body.using.some((s) => !["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"].includes(s))) throw new OfflineOperationError("bad_request", 400);
  if (!Array.isArray(body.methodCalls) || !body.methodCalls.length || body.methodCalls.length > 16) throw new OfflineOperationError("bad_request", 400);
  const callIds = new Set<string>();
  for (const call of body.methodCalls) {
    if (!Array.isArray(call) || call.length !== 3 || !allowed.has(call[0]) || !/^[a-zA-Z0-9_-]{1,80}$/.test(call[2]) || callIds.has(call[2])) throw new OfflineOperationError("bad_request", 400);
    callIds.add(call[2]);
    if (!call[1] || typeof call[1] !== "object" || Array.isArray(call[1]) || typeof call[1].accountId !== "string" || !Object.hasOwn(accounts, call[1].accountId)) throw new OfflineOperationError("account_not_found", 403);
    for (const field of ["create", "update", "onSuccessUpdateEmail"]) if (call[1][field] != null && (typeof call[1][field] !== "object" || Array.isArray(call[1][field]) || Object.values(call[1][field] as object).some((v) => !v || typeof v !== "object" || Array.isArray(v)))) throw new OfflineOperationError("bad_request", 400);
    if (call[1].destroy != null && (!Array.isArray(call[1].destroy) || call[1].destroy.some((id) => typeof id !== "string"))) throw new OfflineOperationError("bad_request", 400);
    for (const key of Object.keys((call[1].create ?? {}) as object)) if (!/^[a-zA-Z0-9_-]{1,80}$/.test(key)) throw new OfflineOperationError("bad_request", 400);
  }
  if (new Set(body.methodCalls.map((call) => call[1].accountId)).size !== 1) throw new OfflineOperationError("mixed_accounts", 400);
  return body;
}
export function markOfflineCreations(body: OfflineRequest, id: string): OfflineRequest {
  const copy = JSON.parse(JSON.stringify(body)) as OfflineRequest;
  for (const [name, args, callId] of copy.methodCalls) if (name === "Email/set") for (const [key, email] of Object.entries((args.create ?? {}) as Record<string, Record<string, unknown>>)) email[OP_HEADER] = `${id}/${callId}/${key}`;
  return copy;
}

/** Only a positively observed submission resolves an uncertain send. Absence is not proof of failure. */
export async function reconcileOfflineSend(body: OfflineRequest, id: string, request: (body: OfflineRequest) => Promise<OfflineResponse>): Promise<OfflineResponse | null> {
  const sends = body.methodCalls.filter(([name]) => name === "EmailSubmission/set");
  if (sends.length !== 1 || Object.keys((sends[0]![1].create ?? {}) as object).length !== 1) return null;
  const accountId = String(sends[0]![1].accountId);
  const query = await request({ using: body.using, methodCalls: [["Email/query", { accountId, filter: { header: ["X-Webmail-Operation-ID", id] }, limit: 20 }, "lookup"]] });
  const ids = query.methodResponses.find((r) => r[0] === "Email/query")?.[1].ids as string[] | undefined;
  if (!ids?.length) return null;
  const got = await request({ using: body.using, methodCalls: [["Email/get", { accountId, ids, properties: ["id", OP_HEADER] }, "emails"], ["EmailSubmission/query", { accountId, filter: { emailIds: ids }, limit: 20 }, "submissions"]] });
  const submissions = got.methodResponses.find((r) => r[0] === "EmailSubmission/query")?.[1].ids as string[] | undefined;
  if (submissions?.length !== 1) return null;
  const emails = got.methodResponses.find((r) => r[0] === "Email/get")?.[1].list as Array<Record<string, string>> | undefined;
  const response: Invocation[] = [];
  for (const [name, args, callId] of body.methodCalls) {
    const created: Record<string, { id: string }> = {};
    if (name === "Email/set" && args.create) for (const key of Object.keys(args.create as object)) {
      const email = emails?.find((e) => e[OP_HEADER] === `${id}/${callId}/${key}`);
      if (!email) return null;
      created[key] = { id: email.id! };
    }
    else if (name === "EmailSubmission/set") for (const key of Object.keys(args.create as object)) created[key] = { id: submissions[0]! };
    else { response.push(["error", { type: "offlineVerificationRequired" }, callId]); continue; }
    const unknownUpdates = Object.fromEntries(Object.keys((args.update ?? {}) as object).map((id) => [id, { type: "offlineVerificationRequired" }]));
    const unknownDeletes = Object.fromEntries(((args.destroy ?? []) as string[]).map((id) => [id, { type: "offlineVerificationRequired" }]));
    response.push([name, { accountId, oldState: null, newState: "reconciled", created, ...(Object.keys(unknownUpdates).length ? { notUpdated: unknownUpdates } : {}), ...(Object.keys(unknownDeletes).length ? { notDestroyed: unknownDeletes } : {}) }, callId]);
  }
  return { methodResponses: response, sessionState: got.sessionState };
}
