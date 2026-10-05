import type { Email, EmailBodyPart, EmailFilter, GetResponse, Id, Invocation, JmapResponse, JmapSession, ChangesResponse, QueryResponse } from "@/jmap/types";
import { BODY_PROPS, FULL_PROPS, LIST_PROPS } from "@/store/mail/props";
import { matchesOffline, sortOffline } from "./query";
import type { OfflineManifest, OfflineOperation, OfflineStatus, OfflineStorage, OfflineTransport, StoredEmail, StoreChange } from "./types";

const MAIL = "urn:ietf:params:jmap:mail";
const SUBMISSION = "urn:ietf:params:jmap:submission";
const CORE = "urn:ietf:params:jmap:core";
export const LOCAL_ID = "offline:";
const json = (value: unknown) => JSON.stringify(value);
const clone = <T,>(value: T): T => JSON.parse(json(value)) as T;
const parse = <T,>(value: string | null): T | null => value === null ? null : JSON.parse(value) as T;
const listKeys = new Set(LIST_PROPS);
const meta = (email: Email): Email => Object.fromEntries(Object.entries(email).filter(([key]) => listKeys.has(key))) as unknown as Email;
export const isConnectionFailure = (err: unknown): boolean => {
  const e = err as { status?: number; name?: string; code?: string };
  return e?.status === 0 || [502, 503, 504].includes(e?.status ?? -1) || ["network_error", "upstream_unavailable", "upstream_timeout"].includes(e?.code ?? "") || e?.name === "TypeError";
};
const errorCode = (err: unknown) => (err as { code?: string }).code ?? "sync_failed";
const uuid = () => crypto.randomUUID();
export function replaceIds(value: unknown, mappings: Record<Id, Id>): unknown {
  if (typeof value === "string") return mappings[value] ?? value;
  if (Array.isArray(value)) return value.map((v) => replaceIds(v, mappings));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [mappings[k] ?? k.split("/").map((s) => mappings[s] ?? s).join("/"), replaceIds(v, mappings)]));
  return value;
}
function walkParts(parts: EmailBodyPart[]): EmailBodyPart[] {
  return parts.flatMap((p) => [p, ...walkParts(p.subParts ?? [])]);
}
function partsOf(email: Email) {
  return walkParts([...(email.bodyStructure ? [email.bodyStructure] : []), ...(email.textBody ?? []), ...(email.htmlBody ?? []), ...(email.attachments ?? [])]);
}
function applyPatch(email: Email, patch: Record<string, unknown>): Email {
  const next = clone(email) as unknown as Record<string, unknown>;
  for (const [path, value] of Object.entries(patch)) {
    const segments = path.split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
    let obj = next;
    for (const segment of segments.slice(0, -1)) {
      if (!obj[segment] || typeof obj[segment] !== "object") obj[segment] = {};
      obj = obj[segment] as Record<string, unknown>;
    }
    const key = segments.at(-1)!;
    if (value === null) delete obj[key]; else obj[key] = clone(value);
  }
  return next as unknown as Email;
}
function resolveReferences(value: unknown, creations: Record<string, Id>): unknown {
  if (typeof value === "string" && value.startsWith("#")) return creations[value.slice(1)] ?? value;
  if (Array.isArray(value)) return value.map((v) => resolveReferences(v, creations));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.startsWith("#") ? creations[k.slice(1)] ?? k : k, resolveReferences(v, creations)]));
  return value;
}

/** Native account repository. UI mutations and their outbox entry share a disk transaction. */
export class OfflineEngine {
  manifest: OfflineManifest | null = null;
  scope = "";
  private emails = new Map<Id, StoredEmail>();
  private tail: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private listeners = new Set<() => void>();
  status: OfflineStatus = { enabled: false, online: true, syncing: false, lastSync: null, pending: 0, issues: 0, complete: 0, cached: 0, error: null };
  constructor(readonly store: OfflineStorage, readonly transport: OfflineTransport) {}
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private publish(patch: Partial<OfflineStatus> = {}) {
    const ops = this.manifest?.operations ?? [];
    this.status = { ...this.status, ...patch, enabled: Boolean(this.manifest), pending: ops.filter((o) => o.status === "pending").length,
      issues: ops.filter((o) => o.status !== "pending").length, cached: this.emails.size,
      complete: [...this.emails.values()].filter((e) => e.complete).length, lastSync: this.manifest?.lastSync ?? null };
    this.listeners.forEach((fn) => fn());
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
  async restore(): Promise<JmapSession | null> {
    const profile = parse<{ scope: string; expired?: boolean }>(await this.store.read("profile", "active"));
    if (!profile || profile.expired) return null;
    const manifest = parse<OfflineManifest>(await this.store.read(profile.scope, "manifest"));
    if (!manifest || manifest.v !== 1 || !manifest.session.ihasmail?.remember) return null;
    await this.load(profile.scope, manifest);
    this.publish({ online: false });
    return manifest.session;
  }
  async activate(session: JmapSession, selected = session.primaryAccounts[MAIL]): Promise<void> {
    if (!session.ihasmail?.remember || !selected || !session.accounts[selected]?.isPersonal) return;
    const identity = `${session.username}\0${selected}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
    const scope = Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
    const profile = parse<{ scope: string; username: string }>(await this.store.read("profile", "active"));
    if (profile && profile.username !== session.username) await this.clear();
    const previous = parse<OfflineManifest>(await this.store.read(scope, "manifest"));
    const manifest: OfflineManifest = previous ?? { v: 1, session, accountId: selected, mailboxes: [], identities: [],
      emailState: null, mailboxState: null, lastSync: null, operations: [], mappings: {}, historyDays: 30, maxMessages: 1000, maxBytes: 500 * 1024 * 1024 };
    manifest.session = clone(session);
    await this.store.commit(scope, [{ key: "manifest", value: json(manifest) }]);
    await this.store.commit("profile", [{ key: "active", value: json({ scope, username: session.username }) }]);
    await this.load(scope, manifest);
  }
  private async load(scope: string, manifest: OfflineManifest) {
    this.epoch++;
    this.scope = scope;
    this.manifest = manifest;
    this.emails = new Map(Object.values(await this.store.list(scope, "mail:")).map((s) => { const e = JSON.parse(s) as StoredEmail; return [e.email.id, e]; }));
    this.publish({ error: null });
  }
  pause() { this.epoch++; this.publish({ syncing: false }); }
  setOnline(online: boolean) { this.publish({ online }); }
  async expire() {
    this.pause();
    const epoch = this.epoch;
    const profile = parse<Record<string, unknown>>(await this.store.read("profile", "active"));
    if (epoch !== this.epoch) return;
    if (profile) await this.store.commit("profile", [{ key: "active", value: json({ ...profile, expired: true }) }]);
    if (epoch !== this.epoch) return;
    this.manifest = null;
    this.emails.clear();
    this.publish();
  }
  async clear() {
    this.epoch++;
    this.manifest = null;
    this.emails.clear();
    this.scope = "";
    await this.tail.catch(() => undefined);
    this.manifest = null;
    this.emails.clear();
    this.scope = "";
    await this.store.clear();
    this.publish({ syncing: false, error: null });
  }
  async reload() {
    if (!this.scope) return;
    const m = parse<OfflineManifest>(await this.store.read(this.scope, "manifest"));
    if (m) await this.load(this.scope, m);
  }
  handles(calls: Invocation[]): boolean {
    return Boolean(this.manifest) && calls.length > 0 && calls.every(([name, args]) => args.accountId === this.manifest!.accountId
      && /^(Email|Mailbox|Thread|Identity)\/(get|query|changes|queryChanges|set)$|^EmailSubmission\/set$/.test(name)
      && !name.startsWith("Identity/set") && !name.startsWith("Thread/set"));
  }
  private async save(manifest: OfflineManifest, changes: StoreChange[] = []) {
    await this.store.commit(this.scope, [...changes, { key: "manifest", value: json(manifest) }]);
    this.manifest = manifest;
    for (const change of changes) if (change.key.startsWith("mail:")) {
      const id = change.key.slice(5);
      if (change.value == null) this.emails.delete(id); else this.emails.set(id, JSON.parse(change.value));
    }
    this.publish();
  }
  async request(body: OfflineOperation["request"], options: { readyAt?: number } = {}): Promise<JmapResponse> {
    if (!this.handles(body.methodCalls)) return this.transport.request(body);
    const writes = body.methodCalls.some(([name]) => name.endsWith("/set"));
    const mappings = writes ? this.manifest!.mappings : Object.fromEntries(Object.entries(this.manifest!.mappings).filter(([id]) => !this.emails.has(id)));
    body = replaceIds(body, mappings) as OfflineOperation["request"];
    if (body.methodCalls.some(([name]) => name.endsWith("/set")) && body.methodCalls.some(([name]) => !name.endsWith("/set"))) {
      const responses: Invocation[] = [];
      let createdIds = { ...body.createdIds };
      for (const call of body.methodCalls) {
        if (Object.keys(call[1]).some((key) => key.startsWith("#"))) throw new Error("offline_method_unavailable");
        const result = await this.request({ ...body, methodCalls: [call], createdIds }, options);
        responses.push(...result.methodResponses); createdIds = { ...createdIds, ...result.createdIds };
      }
      return { methodResponses: responses, sessionState: this.manifest!.session.state, createdIds };
    }
    if (body.methodCalls.some(([name]) => name.endsWith("/set"))) {
      if (!this.manifest!.session.ihasmail?.offlineSync) {
        if (!this.status.online) throw new Error("offline_server_upgrade_required");
        return this.transport.request(body);
      }
      return this.exclusive(() => this.queue(body, options.readyAt));
    }
    const allFullGets = body.methodCalls.every(([name, args]) => name === "Email/get" && Array.isArray(args.ids) && args.ids.length > 0
      && (args.ids as Id[]).every((id) => this.emails.get(id)?.full));
    const localRead = body.methodCalls.every(([, args]) => json(args.filter ?? args.ids ?? {}).includes(LOCAL_ID));
    if (!this.status.online || allFullGets || localRead) return this.read(body);
    const epoch = this.epoch;
    try {
      const result = await this.transport.request(body);
      if (epoch !== this.epoch || !this.manifest) throw new Error("offline_account_changed");
      await this.exclusive(() => this.capture(result));
      return this.overlay(result, body);
    } catch (err) {
      if (!isConnectionFailure(err)) throw err;
      this.publish({ online: false });
      return this.read(body);
    }
  }
  private async read(body: OfflineOperation["request"]): Promise<JmapResponse> {
    const m = this.manifest!;
    const methodResponses: Invocation[] = [];
    for (const [name, args, callId] of body.methodCalls) {
      let response: Record<string, unknown>;
      const common = { accountId: m.accountId, state: m.emailState ?? "offline-initial" };
      if (name === "Email/get") {
        const ids = args.ids === null ? [...this.emails.keys()] : args.ids as Id[];
        const list: Email[] = [];
        const needBody = Boolean(args.fetchHTMLBodyValues || args.fetchTextBodyValues) || (args.properties as string[] | undefined)?.includes("bodyValues");
        for (const id of ids) {
          const held = this.emails.get(id);
          if (!held) continue;
          const full = needBody ? parse<Email>(await this.store.read(this.scope, `full:${id}`)) : null;
          if (needBody && !full) continue;
          list.push({ ...(full ?? held.email), mailboxIds: held.email.mailboxIds, keywords: held.email.keywords });
        }
        response = { ...common, list, notFound: ids.filter((id) => !list.some((e) => e.id === id)) };
      } else if (name === "Email/query") {
        let emails = [...this.emails.values()].map((e) => e.email);
        const filter = args.filter as EmailFilter | undefined;
        // Body search covers only persisted content and is explicitly labelled in UI.
        if (json(filter ?? {}).includes('"body"') || json(filter ?? {}).includes('"text"')) {
          emails = await Promise.all(emails.map(async (e) => ({ ...(parse<Email>(await this.store.read(this.scope, `full:${e.id}`)) ?? e), keywords: e.keywords, mailboxIds: e.mailboxIds })));
        }
        emails = sortOffline(emails.filter((e) => matchesOffline(e, filter)), args.sort as Parameters<typeof sortOffline>[1]);
        if (args.collapseThreads) { const seen = new Set<Id>(); emails = emails.filter((e) => !seen.has(e.threadId) && Boolean(seen.add(e.threadId))); }
        const position = Number(args.position ?? 0), limit = Number(args.limit ?? 50);
        response = { accountId: m.accountId, queryState: `offline-${m.lastSync ?? 0}`, canCalculateChanges: false, position, total: emails.length, ids: emails.slice(position, position + limit).map((e) => e.id) };
      } else if (name === "Thread/get") {
        const ids = args.ids as Id[];
        response = { ...common, list: ids.map((id) => ({ id, emailIds: [...this.emails.values()].filter((e) => e.email.threadId === id).map((e) => e.email.id) })), notFound: [] };
      } else if (name === "Mailbox/get" || name === "Identity/get") {
        const all = name === "Mailbox/get" ? this.localMailboxes() : m.identities;
        const ids = args.ids as Id[] | null;
        const list = ids ? all.filter((e) => ids.includes(e.id)) : all;
        response = { ...common, state: m.mailboxState ?? "offline-initial", list, notFound: ids?.filter((id) => !list.some((e) => e.id === id)) ?? [] };
      } else if (name.endsWith("/changes")) {
        response = { ...common, oldState: args.sinceState, newState: args.sinceState, hasMoreChanges: false, created: [], updated: [], destroyed: [] };
      } else if (name.endsWith("/queryChanges")) {
        methodResponses.push(["error", { type: "cannotCalculateChanges" }, callId]); continue;
      } else throw new Error("offline_method_unavailable");
      methodResponses.push([name, response, callId]);
    }
    return { methodResponses, sessionState: m.session.state };
  }
  private localMailboxes() {
    return this.manifest!.mailboxes.map((m) => {
      const emails = [...this.emails.values()].filter((e) => e.email.mailboxIds[m.id]);
      return this.status.online && !m.id.startsWith(LOCAL_ID) ? m : { ...m, totalEmails: emails.length, unreadEmails: emails.filter((e) => !e.email.keywords.$seen).length,
        totalThreads: new Set(emails.map((e) => e.email.threadId)).size, unreadThreads: new Set(emails.filter((e) => !e.email.keywords.$seen).map((e) => e.email.threadId)).size };
    });
  }
  private overlayMailboxes(boxes: OfflineManifest["mailboxes"]) {
    const m = this.manifest!;
    let next = [...boxes, ...m.mailboxes.filter((box) => box.id.startsWith(LOCAL_ID) && !m.mappings[box.id] && !boxes.some((b) => b.id === box.id))];
    for (const op of m.operations) for (const [name, args] of (replaceIds(op.request, m.mappings) as OfflineOperation["request"]).methodCalls) if (name === "Mailbox/set") {
      const updates = args.update as Record<Id, Record<string, unknown>> | undefined;
      next = next.filter((box) => !((args.destroy ?? []) as Id[]).includes(box.id)).map((box) => { const patch = updates?.[box.id]; return patch ? applyPatch(box as unknown as Email, patch) as unknown as typeof box : box; });
    }
    return next;
  }
  private async queue(body: OfflineOperation["request"], readyAt = Date.now()): Promise<JmapResponse> {
    const m = clone(this.manifest!);
    const op: OfflineOperation = { id: uuid(), accountId: m.accountId, createdAt: Date.now(), readyAt, status: "pending", request: clone(body), creations: {}, base: {}, before: {}, beforeMailboxes: {}, send: body.methodCalls.some(([name]) => name === "EmailSubmission/set") };
    const changes: StoreChange[] = [];
    const response: Invocation[] = [];
    const createdIds = { ...body.createdIds };
    const local = new Map(this.emails);
    for (const [name, original, callId] of body.methodCalls) {
      const args = resolveReferences(original, createdIds) as Record<string, unknown>;
      const result: Record<string, unknown> = { accountId: m.accountId, oldState: m.emailState, newState: m.emailState ?? "offline-initial", __offlineQueued: op.id };
      const made: Record<string, unknown> = {}, updated: Record<string, null> = {}, destroyed: Id[] = [];
      op.creations[callId] = {};
      for (const [key, object] of Object.entries((args.create ?? {}) as Record<string, Record<string, unknown>>)) {
        const id = `${LOCAL_ID}${op.id}:${callId}:${key}`;
        createdIds[key] = id;
        op.creations[callId][key] = id;
        made[key] = { id, ...(name === "EmailSubmission/set" ? { undoStatus: "pending", sendAt: new Date(readyAt).toISOString() } : {}) };
        if (name === "Email/set") {
          const email = { ...object, id, blobId: id, threadId: id, receivedAt: new Date().toISOString(), size: 0, preview: Object.values((object.bodyValues ?? {}) as Record<string, { value: string }>).map((v) => v.value).join(" ").slice(0, 200), hasAttachment: Boolean((object.attachments as unknown[] | undefined)?.length), keywords: object.keywords ?? {}, mailboxIds: object.mailboxIds ?? {} } as unknown as Email;
          const parts = partsOf(email);
          email.textBody ??= parts.filter((p) => p.type === "text/plain" && p.partId && email.bodyValues?.[p.partId]);
          email.htmlBody ??= parts.filter((p) => p.type === "text/html" && p.partId && email.bodyValues?.[p.partId]);
          email.attachments ??= parts.filter((p) => Boolean(p.blobId) && (p.disposition === "attachment" || p.disposition === "inline"));
          email.hasAttachment = email.attachments.length > 0;
          const stored = { email: meta(email), full: true, complete: true };
          local.set(id, stored);
          changes.push({ key: `mail:${id}`, value: json(stored) }, { key: `full:${id}`, value: json(email) });
        } else if (name === "Mailbox/set") { op.beforeMailboxes![id] = null; m.mailboxes.push({ ...object, id, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true, myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true } } as unknown as OfflineManifest["mailboxes"][number]); }
      }
      for (const [id, patch] of Object.entries((args.update ?? {}) as Record<Id, Record<string, unknown>>)) {
        if (name === "Email/set") {
          const existing = local.get(id);
          if (!existing) throw new Error("offline_email_not_downloaded");
          op.base[id] ??= { mailboxIds: clone(existing.email.mailboxIds), keywords: clone(existing.email.keywords) };
          op.before![id] ??= clone(existing);
          if (Object.keys(patch).some((key) => !key.startsWith("keywords/") && !key.startsWith("mailboxIds/") && !["keywords", "mailboxIds", "receivedAt"].includes(key))) throw new Error("offline_email_content_immutable");
          const stored = { ...existing, email: applyPatch(existing.email, patch) };
          local.set(id, stored); changes.push({ key: `mail:${id}`, value: json(stored) });
        } else if (name === "Mailbox/set") {
          if (!(id in op.beforeMailboxes!)) op.beforeMailboxes![id] = clone(m.mailboxes.find((box) => box.id === id) ?? null);
          m.mailboxes = m.mailboxes.map((box) => box.id === id ? applyPatch(box as unknown as Email, patch) as unknown as typeof box : box);
        }
        else throw new Error("offline_method_unavailable");
        updated[id] = null;
      }
      for (const id of (args.destroy ?? []) as Id[]) {
        if (name === "Email/set") {
          const existing = local.get(id);
          op.before![id] ??= existing ? clone(existing) : null;
          if (existing) op.base[id] = { mailboxIds: clone(existing.email.mailboxIds), keywords: clone(existing.email.keywords) };
          local.delete(id); changes.push({ key: `mail:${id}`, value: null });
        } else if (name === "Mailbox/set") {
          if (!(id in op.beforeMailboxes!)) op.beforeMailboxes![id] = clone(m.mailboxes.find((box) => box.id === id) ?? null);
          m.mailboxes = m.mailboxes.filter((box) => box.id !== id);
        }
        else throw new Error("offline_method_unavailable");
        destroyed.push(id);
      }
      if (name === "EmailSubmission/set") {
        // Local Sent must not claim delivery. Keep it in a local Outbox until acknowledged.
        const outbox = `${LOCAL_ID}outbox`;
        if (!m.mailboxes.some((box) => box.id === outbox)) m.mailboxes.push({ id: outbox, name: "Outbox", role: null, parentId: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true, myRights: { mayReadItems: true } } as unknown as OfflineManifest["mailboxes"][number]);
        for (const object of Object.values((args.create ?? {}) as Record<string, { emailId: Id }>)) {
          const existing = local.get(object.emailId);
          if (existing) { const keywords = { ...existing.email.keywords }; delete keywords.$draft; const stored = { ...existing, email: { ...existing.email, keywords, mailboxIds: { [outbox]: true } } }; local.set(object.emailId, stored); changes.push({ key: `mail:${object.emailId}`, value: json(stored) }); }
        }
      }
      if (Object.keys(made).length) result.created = made;
      if (Object.keys(updated).length) result.updated = updated;
      if (destroyed.length) result.destroyed = destroyed;
      response.push([name, result, callId]);
    }
    m.operations.push(op);
    // Write first. UI changes happen only after an atomic durable commit succeeds.
    await this.save(m, changes);
    return { methodResponses: response, sessionState: m.session.state, createdIds };
  }
  async cacheBlob(blobId: Id, blob: Blob, pending = false): Promise<void> {
    if (!this.manifest) throw new Error("offline_not_enabled");
    const epoch = this.epoch, scope = this.scope;
    if (await this.store.bytes(scope) + blob.size * 1.4 > this.manifest.maxBytes) throw Object.assign(new Error("offline_storage_full"), { code: "offline_storage_full" });
    const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(reader.error); reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? ""); reader.readAsDataURL(blob); });
    if (epoch !== this.epoch || !this.manifest) throw new Error("offline_account_changed");
    await this.store.commit(scope, [{ key: `${pending ? "pendingBlob" : "blob"}:${blobId}`, value: json({ type: blob.type, data, size: blob.size }) }]);
  }
  async blob(blobId: Id): Promise<Blob | null> {
    const mapped = this.manifest?.mappings[blobId] ?? blobId;
    const stored = parse<{ type: string; data: string }>(await this.store.read(this.scope, `${blobId.startsWith(LOCAL_ID) ? "pendingBlob" : "blob"}:${blobId}`))
      ?? parse<{ type: string; data: string }>(await this.store.read(this.scope, `blob:${mapped}`));
    if (!stored) return null;
    const bytes = Uint8Array.from(atob(stored.data), (c) => c.charCodeAt(0));
    return new Blob([bytes], { type: stored.type });
  }
  async upload(blob: Blob): Promise<{ accountId: Id; blobId: Id; type: string; size: number }> {
    const id = `${LOCAL_ID}blob:${uuid()}`;
    await this.cacheBlob(id, blob, true);
    return { accountId: this.manifest!.accountId, blobId: id, type: blob.type || "application/octet-stream", size: blob.size };
  }
  private async capture(result: JmapResponse) {
    if (!this.manifest) return;
    const m = clone(this.manifest), changes: StoreChange[] = [];
    for (const [name, args] of result.methodResponses) {
      if (args.accountId !== m.accountId) continue;
      if (name === "Email/get") for (const email of (args.list ?? []) as Email[]) {
        const held = this.emails.get(email.id);
        const full = Boolean(email.bodyValues);
        if (this.deletedPending(email.id)) continue;
        const stored: StoredEmail = { email: meta(this.applyPending({ ...held?.email, ...email })), full: full && Object.values(email.bodyValues ?? {}).every((v) => !v.isTruncated) || Boolean(held?.full), complete: Boolean(held?.complete), pinned: held?.pinned };
        changes.push({ key: `mail:${email.id}`, value: json(stored) });
        if (full) changes.push({ key: `full:${email.id}`, value: json(email) });
      }
      else if (name === "Mailbox/get") { m.mailboxes = this.overlayMailboxes(args.list as typeof m.mailboxes); m.mailboxState = String(args.state); }
      else if (name === "Identity/get") m.identities = args.list as typeof m.identities;
    }
    await this.save(m, changes);
  }
  private overlay(result: JmapResponse, body: OfflineOperation["request"]): JmapResponse {
    const m = this.manifest!;
    const queuedIds = new Set(m.operations.flatMap((op) => Object.keys(op.base)));
    return { ...result, methodResponses: result.methodResponses.map(([name, args, callId]) => {
      if (name === "Mailbox/get") {
        const ids = body.methodCalls.find((call) => call[2] === callId)?.[1].ids as Id[] | null;
        return [name, { ...args, list: this.localMailboxes().filter((box) => !ids || ids.includes(box.id)) }, callId];
      }
      if (name === "Email/get") return [name, { ...args, list: (args.list as Email[]).filter((e) => !queuedIds.has(e.id) || this.emails.has(e.id)).map((e) => queuedIds.has(e.id) ? { ...e, ...this.emails.get(e.id)!.email } : e) }, callId];
      if (name === "Email/query") {
        const query = body.methodCalls.find((call) => call[2] === callId)?.[1];
        const keep = (email: Email) => { try { return matchesOffline(email, query?.filter as EmailFilter | undefined); } catch { return true; } };
        const ids = (args.ids as Id[]).filter((id) => !queuedIds.has(id) || this.emails.has(id) && keep(this.emails.get(id)!.email));
        const local = [...this.emails.values()].filter((row) => row.email.id.startsWith(LOCAL_ID) && keep(row.email)).map((row) => row.email.id);
        return [name, { ...args, ids: [...new Set([...local, ...ids])], total: Math.max(0, Number(args.total ?? ids.length) + local.length - ((args.ids as Id[]).length - ids.length)) }, callId];
      }
      return [name, args, callId];
    }) };
  }
  async sync(): Promise<void> {
    if (!this.manifest || this.status.syncing) return;
    const epoch = this.epoch;
    this.publish({ syncing: true, error: null });
    try {
      await this.exclusive(async () => {
        await this.flush(epoch);
        if (epoch !== this.epoch || !this.manifest) return;
        await this.pull(epoch);
        if (epoch === this.epoch && this.manifest) await this.save({ ...this.manifest, lastSync: Date.now() });
      });
      if (epoch === this.epoch) this.publish({ online: true });
    } catch (err) {
      if (epoch === this.epoch) this.publish({ online: !isConnectionFailure(err), error: errorCode(err) });
    } finally { if (epoch === this.epoch) this.publish({ syncing: false }); }
  }
  private async flush(epoch: number) {
    for (const original of [...this.manifest!.operations]) {
      if (epoch !== this.epoch || !this.manifest) return;
      if (original.status === "failed" || original.readyAt > Date.now()) continue;
      const op = clone(original), m = clone(this.manifest);
      try {
        const blobIds = new Set<string>();
        const collect = (value: unknown) => {
          if (Array.isArray(value)) value.forEach(collect);
          else if (value && typeof value === "object") { const o = value as Record<string, unknown>; if (typeof o.blobId === "string" && o.blobId.startsWith(`${LOCAL_ID}blob:`)) blobIds.add(o.blobId); Object.values(o).forEach(collect); }
        };
        collect(op.request);
        for (const id of blobIds) if (!m.mappings[id]) {
          const blob = await this.blob(id);
          if (!blob) throw Object.assign(new Error("offline_attachment_missing"), { code: "offline_attachment_missing" });
          const uploaded = await this.transport.upload(op.accountId, blob);
          if (epoch !== this.epoch) return;
          m.mappings[id] = uploaded.blobId;
          const cached = await this.store.read(this.scope, `pendingBlob:${id}`);
          await this.save(m, cached ? [{ key: `blob:${uploaded.blobId}`, value: cached }, { key: `pendingBlob:${id}`, value: null }] : []);
        }
        const request = replaceIds(op.request, m.mappings) as OfflineOperation["request"];
        const unresolved = (value: unknown, field = ""): boolean => {
          if (["value", "subject", "name", "preview"].includes(field) || field.startsWith("header:")) return false;
          if (typeof value === "string") return value.startsWith(LOCAL_ID);
          if (Array.isArray(value)) return value.some((v) => unresolved(v, field));
          return Boolean(value && typeof value === "object" && Object.entries(value).some(([k, v]) => k.startsWith(LOCAL_ID) || unresolved(v, k)));
        };
        if (unresolved(request)) throw Object.assign(new Error("offline_dependency_missing"), { code: "offline_dependency_missing" });
        const response = await this.transport.operation(op, request);
        if (epoch !== this.epoch || !this.manifest) return;
        const next = clone(this.manifest), changes: StoreChange[] = [];
        const errors = response.methodResponses.some(([name, args]) => name === "error" || ["notCreated", "notUpdated", "notDestroyed"].some((key) => Object.keys((args[key] ?? {}) as object).length));
        const sendAccepted = response.methodResponses.some(([name, args]) => name === "EmailSubmission/set" && Object.keys((args.created ?? {}) as object).length > 0);
        for (const [, args, callId] of response.methodResponses) for (const [key, object] of Object.entries((args.created ?? {}) as Record<string, { id: Id }>)) {
          const localId = op.creations[callId]?.[key];
          if (localId && object.id) { next.mappings[localId] = object.id; if (!errors || sendAccepted) changes.push({ key: `mail:${localId}`, value: null }, { key: `full:${localId}`, value: null }); }
        }
        next.operations = next.operations.map((o) => o.id === op.id ? { ...o, sendAccepted, status: "failed" as const, error: "offline_operation_rejected" } : o);
        if (!errors) next.operations = next.operations.filter((o) => o.id !== op.id);
        await this.save(next, changes);
      } catch (err) {
        if (epoch !== this.epoch || !this.manifest) return;
        if (isConnectionFailure(err)) throw err;
        const code = errorCode(err);
        const next = clone(this.manifest);
        if (code === "operation_in_progress") continue;
        next.operations = next.operations.map((o) => o.id === op.id ? { ...o, status: ["operation_uncertain", "operation_id_reused"].includes(code) ? "uncertain" : "failed", error: code } : o);
        await this.save(next);
      }
    }
  }
  private async pull(epoch: number) {
    const m = this.manifest!;
    const call = async <T,>(name: string, args: Record<string, unknown>): Promise<T> => {
      const result = await this.transport.request({ using: [CORE, MAIL, SUBMISSION].filter((cap) => cap === CORE || Boolean(m.session.capabilities[cap]) || Boolean(m.session.accounts[m.accountId]?.accountCapabilities[cap])), methodCalls: [[name, { accountId: m.accountId, ...args }, "sync"]] });
      const inv = result.methodResponses.find((r) => r[2] === "sync");
      if (!inv || inv[0] === "error") throw Object.assign(new Error(String(inv?.[1].type ?? "sync_failed")), { code: inv?.[1].type ?? "sync_failed" });
      if (epoch !== this.epoch) throw new Error("offline_account_changed");
      return inv[1] as T;
    };
    const boxes = await call<GetResponse<OfflineManifest["mailboxes"][number]>>("Mailbox/get", { ids: null });
    await this.save({ ...this.manifest!, mailboxes: this.overlayMailboxes(boxes.list), mailboxState: boxes.state });
    if (!m.emailState) await this.resnapshot(call);
    else {
      try {
        let more = true;
        while (more && epoch === this.epoch) {
          const delta = await call<ChangesResponse>("Email/changes", { sinceState: this.manifest!.emailState, maxChanges: 100 });
          const changes: StoreChange[] = delta.destroyed.flatMap((id) => [{ key: `mail:${id}`, value: null }, { key: `full:${id}`, value: null }]);
          const ids = [...new Set([...delta.created, ...delta.updated])];
          if (ids.length) {
            const got = await call<GetResponse<Email>>("Email/get", { ids, properties: LIST_PROPS });
            for (const email of got.list) {
              const held = this.emails.get(email.id);
              if (!this.deletedPending(email.id)) changes.push({ key: `mail:${email.id}`, value: json({ email: this.applyPending(email), full: Boolean(held?.full), complete: Boolean(held?.complete), pinned: held?.pinned }) });
            }
            for (const id of got.notFound) changes.push({ key: `mail:${id}`, value: null }, { key: `full:${id}`, value: null });
          }
          // Commit new cursor only with all metadata changes. Body completeness is independent.
          await this.save({ ...this.manifest!, emailState: delta.newState }, changes);
          more = delta.hasMoreChanges;
        }
      } catch (err) { if (errorCode(err) !== "cannotCalculateChanges") throw err; await this.resnapshot(call); }
    }
    const wanted = [...this.emails.values()].filter((e) => !e.complete && !e.email.id.startsWith(LOCAL_ID)).sort((a, b) => b.email.receivedAt.localeCompare(a.email.receivedAt));
    for (const held of wanted) {
      if (epoch !== this.epoch) return;
      if (await this.store.bytes(this.scope) >= this.manifest!.maxBytes) throw Object.assign(new Error("offline_storage_full"), { code: "offline_storage_full" });
      let email = parse<Email>(await this.store.read(this.scope, `full:${held.email.id}`));
      if (!email) {
        const got = await call<GetResponse<Email>>("Email/get", { ids: [held.email.id], properties: FULL_PROPS, fetchTextBodyValues: true, fetchHTMLBodyValues: true, maxBodyValueBytes: 2 * 1024 * 1024, bodyProperties: BODY_PROPS });
        email = got.list[0] ?? null;
        if (!email) continue;
        const current = this.emails.get(email.id)!;
        await this.save(this.manifest!, [{ key: `full:${email.id}`, value: json(email) }, { key: `mail:${email.id}`, value: json({ ...current, full: Object.values(email.bodyValues ?? {}).every((v) => !v.isTruncated) }) }]);
      }
      for (const part of partsOf(email)) {
        const value = part.partId ? email.bodyValues?.[part.partId] : undefined;
        if (value?.isTruncated && part.blobId) {
          const blob = await this.blob(part.blobId) ?? await this.transport.blob(m.accountId, part.blobId, part.type);
          await this.cacheBlob(part.blobId, blob);
          value.value = await blob.text(); value.isTruncated = false;
        }
      }
      const downloads = new Map(partsOf(email).filter((part) => part.blobId).map((part) => [part.blobId, part]));
      for (const [blobId, part] of downloads) if (blobId && !await this.store.read(this.scope, `blob:${blobId}`)) {
        const blob = await this.transport.blob(m.accountId, blobId, part.type);
        if (epoch !== this.epoch) return;
        await this.cacheBlob(blobId, blob);
      }
      const current = this.emails.get(email.id);
      if (!current) continue;
      if (Object.values(email.bodyValues ?? {}).some((v) => v.isTruncated)) throw Object.assign(new Error("offline_body_incomplete"), { code: "offline_body_incomplete" });
      await this.save(this.manifest!, [{ key: `full:${email.id}`, value: json(email) }, { key: `mail:${email.id}`, value: json({ ...current, full: true, complete: true }) }]);
    }
  }
  private applyPending(email: Email): Email {
    let next = email;
    for (const op of this.manifest!.operations) for (const [name, args] of (replaceIds(op.request, this.manifest!.mappings) as OfflineOperation["request"]).methodCalls) if (name === "Email/set") {
      const patch = (args.update as Record<Id, Record<string, unknown>> | undefined)?.[email.id];
      if (patch) next = applyPatch(next, patch);
    }
    return next;
  }
  private deletedPending(id: Id) { return this.manifest!.operations.some((op) => (replaceIds(op.request, this.manifest!.mappings) as OfflineOperation["request"]).methodCalls.some(([name, args]) => name === "Email/set" && ((args.destroy ?? []) as Id[]).includes(id))); }
  private async resnapshot(call: <T>(name: string, args: Record<string, unknown>) => Promise<T>) {
    const m = this.manifest!;
    const baseline = await call<GetResponse<Email>>("Email/get", { ids: [], properties: ["id"] });
    const known = new Set<Id>();
    const wanted = new Set([...this.emails.values()].filter((e) => e.pinned || e.email.id.startsWith(LOCAL_ID)).map((e) => e.email.id));
    let position = 0;
    while (position < m.maxMessages) {
      const q = await call<QueryResponse>("Email/query", { filter: { after: new Date(Date.now() - m.historyDays * 86_400_000).toISOString() }, sort: [{ property: "receivedAt", isAscending: false }], position, limit: Math.min(100, m.maxMessages - position) });
      if (!q.ids.length) break;
      const got = await call<GetResponse<Email>>("Email/get", { ids: q.ids, properties: LIST_PROPS });
      const changes = got.list.map((email) => {
        known.add(email.id);
        const old = this.emails.get(email.id);
        return { key: `mail:${email.id}`, value: json({ email: this.applyPending(email), full: Boolean(old?.full), complete: Boolean(old?.complete), pinned: old?.pinned }) };
      }).filter((change) => !this.deletedPending(change.key.slice(5)));
      await this.save(this.manifest!, changes);
      position += q.ids.length;
      if (q.ids.length < 100) break;
    }
    // Revalidate all older/pinned cached ids too, so a stale cursor never keeps deleted mail forever.
    const older = [...this.emails.keys()].filter((id) => !known.has(id) && !id.startsWith(LOCAL_ID));
    for (let i = 0; i < older.length; i += 100) {
      const got = await call<GetResponse<Email>>("Email/get", { ids: older.slice(i, i + 100), properties: LIST_PROPS });
      const changes: StoreChange[] = got.notFound.flatMap((id) => [{ key: `mail:${id}`, value: null }, { key: `full:${id}`, value: null }]);
      for (const email of got.list) { const old = this.emails.get(email.id)!; wanted.add(email.id); if (!this.deletedPending(email.id)) changes.push({ key: `mail:${email.id}`, value: json({ ...old, email: this.applyPending(email) }) }); }
      await this.save(this.manifest!, changes);
    }
    await this.save({ ...this.manifest!, emailState: baseline.state, backgroundPull: null });
  }
  async setPinned(id: Id, pinned: boolean) {
    await this.exclusive(async () => { const held = this.emails.get(id); if (held) await this.save(this.manifest!, [{ key: `mail:${id}`, value: json({ ...held, pinned }) }]); });
  }
  async writeEditors(value: unknown) {
    const scope = this.scope, epoch = this.epoch;
    if (!this.manifest) return;
    const encoded = json(value);
    await this.exclusive(async () => { if (epoch === this.epoch && this.manifest) await this.store.commit(scope, [{ key: "editors", value: encoded }]); });
  }
  async readEditors<T>(): Promise<T | null> { return this.manifest ? parse<T>(await this.store.read(this.scope, "editors")) : null; }
  async configureCache(historyDays: number, maxBytes: number) {
    await this.exclusive(async () => {
      if (!this.manifest || ![7, 30, 90, 365].includes(historyDays) || ![100, 500, 1024].includes(maxBytes)) throw new Error("offline_invalid_settings");
      await this.save({ ...this.manifest, historyDays, maxBytes: maxBytes * 1024 * 1024, emailState: null });
    });
  }
  async clearDownloaded() {
    await this.exclusive(async () => {
      if (!this.manifest) return;
      const protectedIds = new Set(this.manifest.operations.flatMap((op) => [...Object.keys(op.before ?? {}), ...Object.values(op.creations).flatMap(Object.values)]));
      const changes: StoreChange[] = [];
      // Keep all blobs while a draft/outbox exists: an attachment may be shared by several messages.
      const editors = await this.readEditors<{ drafts?: unknown[] }>();
      if (!this.manifest.operations.length && !editors?.drafts?.length && ![...this.emails.values()].some((e) => e.pinned)) for (const key of Object.keys(await this.store.list(this.scope, "blob:"))) changes.push({ key, value: null });
      for (const [id, row] of this.emails) if (!protectedIds.has(id) && !id.startsWith(LOCAL_ID) && !row.pinned) {
        changes.push({ key: `full:${id}`, value: null }, { key: `mail:${id}`, value: json({ ...row, full: false, complete: false }) });
      }
      await this.save(this.manifest, changes);
    });
  }
  async cancel(id: string) {
    await this.exclusive(async () => {
      const op = this.manifest?.operations.find((o) => o.id === id);
      if (!op || op.status === "uncertain" || op.sendAccepted) throw new Error("offline_cannot_cancel_uncertain");
      const dependentIds = [...Object.keys(op.before ?? {}), ...Object.keys(op.beforeMailboxes ?? {}), ...Object.values(op.creations).flatMap(Object.values)];
      const later = this.manifest!.operations.slice(this.manifest!.operations.indexOf(op) + 1);
      if (later.some((o) => dependentIds.some((id) => json(o.request).includes(id)))) throw new Error("offline_cancel_later_changes_first");
      const m = clone(this.manifest!);
      m.operations = m.operations.filter((o) => o.id !== id);
      const changes: StoreChange[] = Object.values(op.creations).flatMap((created) => Object.values(created).flatMap((id) => [{ key: `mail:${id}`, value: null }, { key: `full:${id}`, value: null }]));
      for (const [id, before] of Object.entries(op.before ?? {})) changes.push({ key: `mail:${id}`, value: before ? json(before) : null });
      for (const [id, before] of Object.entries(op.beforeMailboxes ?? {})) { m.mailboxes = m.mailboxes.filter((box) => box.id !== id); if (before) m.mailboxes.push(before); }
      m.emailState = null;
      await this.save(m, changes);
    });
  }
  async dismissAccepted(id: string) {
    await this.exclusive(async () => {
      const m = this.manifest;
      if (!m?.operations.some((o) => o.id === id && o.sendAccepted)) throw new Error("offline_not_confirmed");
      await this.save({ ...m, operations: m.operations.filter((o) => o.id !== id), emailState: null });
    });
  }
}
