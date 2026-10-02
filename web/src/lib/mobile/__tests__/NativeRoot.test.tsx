import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Capacitor } from "@capacitor/core";
const bridge = vi.hoisted(() => ({ initialize: vi.fn(), config: vi.fn() }));
vi.mock("../runtime", () => ({ initializeNative: bridge.initialize }));
vi.mock("@capacitor/core", async (original) => ({ ...await original<object>(), CapacitorHttp: { get: bridge.config } }));
import { NativeRoot } from "../NativeRoot";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubEnv("VITE_MOBILE_BUILD", "true");
  vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
  localStorage.clear();
  bridge.initialize.mockReset().mockResolvedValue(undefined);
  bridge.config.mockReset().mockResolvedValue({ status: 200, data: { appName: "Webmail" } });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("native launch screens", () => {
  it("shows a usable retry screen after a bridge failure and then opens the app", async () => {
    bridge.initialize.mockRejectedValueOnce(new Error("internal bridge details"));
    await act(async () => root.render(<NativeRoot><p>Mailbox ready</p></NativeRoot>));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Webmail could not start.");
    expect(host.textContent).not.toContain("internal bridge details");
    await act(async () => host.querySelector("button")?.click());
    expect(host.textContent).toBe("Mailbox ready");
    expect(bridge.initialize).toHaveBeenCalledTimes(2);
  });

  it("opens the app on a clean install without a server form", async () => {
    await act(async () => root.render(<NativeRoot><p>Mailbox ready</p></NativeRoot>));
    expect(host.textContent).toBe("Mailbox ready");
    expect(host.querySelector('input[type="url"]')).toBeNull();
    expect(bridge.config).not.toHaveBeenCalled();
  });
});
