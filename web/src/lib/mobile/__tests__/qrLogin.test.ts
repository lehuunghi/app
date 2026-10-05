import { describe, it, expect } from "vitest";
import { parseLoginQr } from "../qrLogin";
const valid = { type: "webmail-login", version: 1, api: "https://webmail.jmail.vn/api/auth/qr", id: "x".repeat(43) };
describe("sign-in QR validation", () => {
  it("accepts only this deployment and its exact protocol", () => {
    expect(parseLoginQr(JSON.stringify(valid))).toBe(valid.id);
    for (const change of [{ api: "https://evil.example/api/auth/qr" }, { api: "http://webmail.jmail.vn/api/auth/qr" }, { api: valid.api + "?next=evil" }, { version: 2 }, { id: "short" }, { type: "other" }]) expect(() => parseLoginQr(JSON.stringify({ ...valid, ...change }))).toThrow();
    for (const value of ["not json", "null", "[]"]) expect(() => parseLoginQr(value)).toThrow();
  });
});
