import type { Id, StateChange } from "./types";
import { withBase } from "@/lib/basePath";
import { isNativeApp } from "@/lib/mobile/config";
import { nativeAppIsActive } from "@/lib/mobile/runtime";
import { CAP, client } from "./client";

export type PushListener = (accountId: Id, type: string, newState: string) => void;

/** Connected, trying to connect, or not trying. */
export type PushState = "connected" | "connecting" | "disconnected";

/**
 * JMAP push over Server-Sent Events (proxied through our server).
 * Emits per-type state changes so stores can refresh incrementally.
 */
class PushManager {
  private es: EventSource | null = null;
  private listeners = new Set<PushListener>();
  private connectionListeners = new Set<(state: PushState) => void>();
  private backoff = 1000;
  private reconnectTimer: number | null = null;
  private stopped = true;
  private generation = 0;
  private pollTimer: number | null = null;
  private lastStates = new Map<string, string>();
  connected = false;
  /**
   * Finer than `connected`, which cannot tell "trying" from "given up".
   * "connecting" covers the first attempt and every backoff retry.
   */
  state: PushState = "disconnected";

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.generation++;
    if (isNativeApp()) {
      window.addEventListener("webmail:app-state", this.onNativeState);
      window.addEventListener("online", this.onNativeState);
      void this.pollNative();
      return;
    }
    this.connect();
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("online", this.onOnline);
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    window.removeEventListener("webmail:app-state", this.onNativeState);
    window.removeEventListener("online", this.onNativeState);
    if (this.pollTimer) window.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.lastStates.clear();
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("online", this.onOnline);
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.es?.close();
    this.es = null;
    this.setState("disconnected");
  }

  subscribe(fn: PushListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onConnection(fn: (state: PushState) => void): () => void {
    this.connectionListeners.add(fn);
    return () => this.connectionListeners.delete(fn);
  }

  private setState(v: PushState) {
    if (this.state === v) return;
    this.state = v;
    this.connected = v === "connected";
    for (const fn of this.connectionListeners) fn(v);
  }

  private onVisibility = () => {
    if (document.visibilityState === "visible" && !this.es && !this.stopped) this.connect();
  };

  private onOnline = () => {
    if (!this.es && !this.stopped) this.connect();
  };

  private onNativeState = () => {
    if (this.stopped) return;
    if (this.pollTimer) window.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.generation++;
    if (nativeAppIsActive()) void this.pollNative();
    else this.setState("disconnected");
  };

  /** EventSource cannot share the native HTTP cookie jar. Poll JMAP states
   * only in the foreground; this is synchronization, not background push. */
  private async pollNative(): Promise<void> {
    if (this.stopped || !nativeAppIsActive()) return;
    const generation = this.generation;
    this.setState("connecting");
    const supported: Array<[string, string[]]> = [
      [CAP.mail, ["Mailbox", "Email"]], [CAP.contacts, ["AddressBook", "ContactCard"]],
      [CAP.calendars, ["Calendar", "CalendarEvent"]], [CAP.filenode, ["FileNode"]],
      [CAP.sieve, ["SieveScript"]], [CAP.submission, ["Identity", "EmailSubmission"]],
    ];
    const jobs: Array<Promise<boolean>> = [];
    for (const [accountId, account] of Object.entries(client.session?.accounts ?? {})) {
      for (const [capability, types] of supported) {
        if (!(capability in account.accountCapabilities)) continue;
        for (const type of types) jobs.push((async () => {
          try {
            const result = await client.call<{ state: string }>(`${type}/get`, { accountId, ids: [] });
            if (generation !== this.generation || this.stopped || typeof result.state !== "string") return false;
            const key = `${accountId}/${type}`;
            const previous = this.lastStates.get(key);
            this.lastStates.set(key, result.state);
            if (previous !== undefined && previous !== result.state) {
              for (const listener of this.listeners) listener(accountId, type, result.state);
            }
            return true;
          } catch { return false; }
        })());
      }
    }
    const results = await Promise.all(jobs);
    if (generation !== this.generation || this.stopped) return;
    this.setState(results.some(Boolean) ? "connected" : "connecting");
    this.pollTimer = window.setTimeout(() => { this.pollTimer = null; void this.pollNative(); }, 30000);
  }

  private connect(): void {
    if (this.stopped || this.es) return;
    if (this.state !== "connected") this.setState("connecting");
    const url = withBase(`/api/events?types=*&closeafter=no&ping=30`);
    const es = new EventSource(url, { withCredentials: true });
    this.es = es;
    es.onopen = () => {
      this.backoff = 1000;
      this.setState("connected");
    };
    es.addEventListener("state", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data as string) as StateChange;
        if (data["@type"] !== "StateChange") return;
        for (const [accountId, types] of Object.entries(data.changed)) {
          for (const [type, state] of Object.entries(types)) {
            const key = `${accountId}/${type}`;
            if (this.lastStates.get(key) === state) continue;
            this.lastStates.set(key, state);
            for (const fn of this.listeners) fn(accountId, type, state);
          }
        }
      } catch {
        /* ignore malformed */
      }
    });
    es.addEventListener("ping", () => {
      /* keepalive */
    });
    es.onerror = () => {
      es.close();
      this.es = null;
      if (this.stopped) { this.setState("disconnected"); return; }
      // A retry is already scheduled below, so this is "trying", not "given up".
      this.setState("connecting");
      const delay = Math.min(this.backoff, 60_000);
      this.backoff = Math.min(this.backoff * 2, 60_000);
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    };
  }
}

export const push = new PushManager();
