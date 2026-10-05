import { registerPlugin } from "@capacitor/core";
import { mobileApiServerUrl } from "./config";

export const QrLoginScanner = registerPlugin<{ scan(): Promise<{ value: string }> }>("QrLoginScanner");
export function parseLoginQr(value: string): string {
  let data: { type?: unknown; version?: unknown; api?: unknown; id?: unknown };
  try { data = JSON.parse(value); } catch { throw new Error("invalid_qr"); }
  if (!data || data.type !== "webmail-login" || data.version !== 1 || data.api !== mobileApiServerUrl() + "/api/auth/qr" || typeof data.id !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(data.id)) throw new Error("invalid_qr");
  return data.id;
}
