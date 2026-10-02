import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ active: true, version: "1", call: vi.fn() }));
vi.mock("@/lib/mobile/config", () => ({ isNativeApp: () => true }));
vi.mock("@/lib/mobile/runtime", () => ({ nativeAppIsActive: () => state.active }));
vi.mock("@/lib/basePath", () => ({ withBase: (path: string) => path }));
vi.mock("@/jmap/client", () => ({
  CAP: { mail: "mail", contacts: "contacts", calendars: "calendars", filenode: "files", sieve: "sieve", submission: "submission" },
  client: { session: { accounts: { a1: { accountCapabilities: { mail: {} } } } }, call: state.call },
}));
import { push } from "@/jmap/push";

beforeEach(() => {
  vi.useFakeTimers();
  state.active = true;
  state.version = "1";
  state.call.mockReset().mockImplementation(async () => ({ state: state.version }));
});
afterEach(() => { push.stop(); vi.useRealTimers(); });

describe("native foreground synchronization", () => {
  it("observes JMAP state changes, pauses in the background and refreshes on return", async () => {
    const listener = vi.fn();
    const unsubscribe = push.subscribe(listener);
    push.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.call).toHaveBeenCalledTimes(2);
    expect(listener).not.toHaveBeenCalled();
    state.version = "2";
    await vi.advanceTimersByTimeAsync(30000);
    expect(listener).toHaveBeenCalledWith("a1", "Email", "2");
    state.active = false;
    window.dispatchEvent(new Event("webmail:app-state"));
    const calls = state.call.mock.calls.length;
    await vi.advanceTimersByTimeAsync(90000);
    expect(state.call).toHaveBeenCalledTimes(calls);
    state.version = "3";
    state.active = true;
    window.dispatchEvent(new Event("webmail:app-state"));
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledWith("a1", "Email", "3");
    unsubscribe();
  });

  it("ignores an in-flight reply after sign-out and does not schedule another poll", async () => {
    let resolve!: (value: { state: string }) => void;
    const pending = new Promise<{ state: string }>((done) => { resolve = done; });
    state.call.mockReturnValue(pending);
    push.start();
    push.stop();
    resolve({ state: "2" });
    await vi.advanceTimersByTimeAsync(60000);
    expect(state.call).toHaveBeenCalledTimes(2);
    expect(push.state).toBe("disconnected");
  });
});
