import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { deriveKey, open, seal, sha256 } from "./crypto.js";
import type { LiveSession, SessionBackend } from "./sessions.js";
import type { NativeProvider, Platform } from "./nativePushProviders.js";
import type { MailWatch } from "./nativeMailWatch.js";

interface Device {
  key: string;
  installation: string;
  sessionId: string;
  sessionCreatedAt: number;
  account: string;
  salt: string;
  sealed: string;
  state: string;
  pending?: { state: string; emailId: string };
}
interface Credentials { username: string; authorization: string; token: string; platform: Platform }
export class NativePushError extends Error {
  constructor(public status: 400 | 401 | 409 | 503, public code: string) { super(code); }
}

export function validRegistration(value: unknown): value is { installation: string; token: string; platform: Platform } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.installation === "string" && /^[a-f\d-]{36}$/i.test(v.installation)
    && typeof v.token === "string" && (v.platform === "ios" ? /^[a-f\d]{64,200}$/i.test(v.token)
      : v.platform === "android" && /^[A-Za-z\d_:.-]{20,4096}$/.test(v.token));
}

/** Durable per-device cursors and retry queue. Polling happens on the server,
 * so suspended/killed mobile processes do not need timers or silent pushes.
 * One process owns this file; replicas need a shared transactional backend.
 */
export class NativePush {
  private devices = new Map<string, Device>();
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private registrations = new Map<string, number>();
  private registrationSequence = 0;
  constructor(private sessions: SessionBackend, private provider: NativeProvider,
    private watch: MailWatch, private file: string, private secret: string) {}

  ready(platform: Platform): boolean { return !!this.file && this.provider.ready(platform); }
  private active(device: Device): boolean {
    // Do not resolve a cookie or renew a user's session just for a background
    // check. Logout, revoke-others and expiration take effect without a lease.
    return this.sessions.listForUser(device.account).some((s) => s.id === device.sessionId && s.expiresAt > Date.now());
  }
  private credentials(d: Device): Credentials | null {
    const json = open(d.sealed, deriveKey(`native-push:${d.sessionId}`, this.secret, Buffer.from(d.salt, "base64")));
    try { return json ? JSON.parse(json) as Credentials : null; } catch { return null; }
  }
  private async save(): Promise<void> {
    if (!this.file) return;
    const snapshot = JSON.stringify([...this.devices.values()]);
    const write = this.writes.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.file);
    });
    this.writes = write;
    return write;
  }
  async init(): Promise<void> {
    if (!this.file) return;
    try {
      const rows: Device[] = JSON.parse(await readFile(this.file, "utf8"));
      if (!Array.isArray(rows)) throw new Error("Invalid native notification store");
      for (const d of rows) if (this.active(d) && this.credentials(d)) this.devices.set(d.key, d);
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    await this.save();
    this.timer = setInterval(() => { void this.tick().catch(() => console.warn("[webmail] native notification check failed")); }, 30_000);
    this.timer.unref();
    void this.tick().catch(() => console.warn("[webmail] native notification check failed"));
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
    await this.save();
  }
  status(session: LiveSession, installation: string, platform: Platform) {
    const enabled = [...this.devices.values()].some((d) => d.sessionId === session.id && d.installation === installation && this.active(d));
    return { ready: this.ready(platform), enabled, binding: sha256(session.id) };
  }

  async register(session: LiveSession, body: unknown) {
    if (!validRegistration(body)) throw new NativePushError(400, "invalid_device");
    if (!this.ready(body.platform)) throw new NativePushError(503, "native_push_unavailable");
    if (!session.remember) throw new NativePushError(409, "trusted_device_required");
    if (this.sessions.listForUser(session.account).filter((s) => s.id === session.id && s.expiresAt > Date.now()).length !== 1) throw new NativePushError(401, "unauthenticated");
    const key = sha256(`${body.platform}:${body.token}`);
    const previous = this.devices.get(key);
    if (previous && previous.sessionId !== session.id && previous.sessionCreatedAt > session.createdAt) throw new NativePushError(409, "stale_device_session");
    const sequence = ++this.registrationSequence;
    this.registrations.set(key, sequence);
    let baseline, latestRequest = false;
    try {
      baseline = previous?.sessionId === session.id ? { state: previous.state } : await this.watch(session);
      latestRequest = this.registrations.get(key) === sequence;
    }
    finally { if (this.registrations.get(key) === sequence) this.registrations.delete(key); }
    // A later request may have finished while this one's mail baseline waited.
    // Never let an old account's slow response reclaim a newly rebound token.
    const latest = this.devices.get(key);
    if (!latestRequest || (latest && latest.sessionId !== session.id && latest.sessionCreatedAt > session.createdAt)) throw new NativePushError(409, "stale_device_session");
    const salt = randomBytes(32);
    const d: Device = { key, installation: body.installation, sessionId: session.id, sessionCreatedAt: session.createdAt, account: session.account,
      salt: salt.toString("base64"), state: baseline.state,
      pending: previous?.sessionId === session.id ? previous.pending : undefined,
      // Background sending is opt-in and needs credentials with no cookie
      // present. Seal separately under APP_SECRET; never persist cookie secrets
      // or plaintext mail passwords. Document this stronger server trust.
      sealed: seal(JSON.stringify({ username: session.username, authorization: session.authorization, token: body.token, platform: body.platform }),
        deriveKey(`native-push:${session.id}`, this.secret, salt)) };
    if (!this.active(d)) throw new NativePushError(401, "unauthenticated");
    if ([...this.devices.values()].filter((v) => v.account === session.account).length >= 20 && !previous) throw new NativePushError(409, "device_limit");
    // Token ownership moves only when the authenticated caller possesses that
    // token. A different session cannot delete a registration by guessing an ID.
    for (const old of this.devices.values()) if (old.sessionId === session.id && old.installation === body.installation) this.devices.delete(old.key);
    this.devices.set(key, d);
    try { await this.save(); } catch (err) { this.devices.delete(key); throw err; }
    return this.status(session, body.installation, body.platform);
  }
  async remove(sessionId: string, installation?: string): Promise<void> {
    for (const d of this.devices.values()) if (d.sessionId === sessionId && (!installation || d.installation === installation)) this.devices.delete(d.key);
    await this.save();
  }
  async refreshCredentials(session: LiveSession): Promise<void> {
    let changed = false;
    for (const d of this.devices.values()) {
      if (d.sessionId !== session.id) continue;
      const c = this.credentials(d);
      if (!c || c.authorization === session.authorization) continue;
      d.sealed = seal(JSON.stringify({ ...c, username: session.username, authorization: session.authorization }),
        deriveKey(`native-push:${d.sessionId}`, this.secret, Buffer.from(d.salt, "base64")));
      changed = true;
    }
    if (changed) await this.save();
  }
  tick(): Promise<void> {
    return this.running ??= this.check().finally(() => { this.running = undefined; });
  }
  private async check(): Promise<void> {
    const rows = [...this.devices.values()];
    // Bound upstream/provider concurrency, including after a process restart.
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
      while (next < rows.length) {
        const d = rows[next++]!;
        try { await this.checkDevice(d); } catch { /* preserve cursor; retry on next tick */ }
      }
    }));
    await this.save();
  }
  private async checkDevice(d: Device): Promise<void> {
    if (this.devices.get(d.key) !== d) return;
    const c = this.credentials(d);
    if (!c || !this.active(d)) { this.devices.delete(d.key); return; }
    if (!this.ready(c.platform)) return;
    if (!d.pending) {
      const change = await this.watch({ id: d.sessionId, account: d.account, username: c.username, authorization: c.authorization } as LiveSession, d.state);
      if (this.devices.get(d.key) !== d || !this.active(d)) return;
      if (!change.emailId) { d.state = change.state; return; }
      d.pending = { state: change.state, emailId: change.emailId };
      // Persist before sending: a crash never skips an undelivered alert.
      await this.save();
    }
    if (this.devices.get(d.key) !== d || !this.active(d)) return;
    const result = await this.provider.send(c.platform, c.token, { binding: sha256(d.sessionId), emailId: d.pending.emailId });
    if (this.devices.get(d.key) !== d) return;
    if (result === "invalid") this.devices.delete(d.key);
    else if (result === "sent") { d.state = d.pending.state; d.pending = undefined; }
  }
}
