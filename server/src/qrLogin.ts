import { randomBytes, timingSafeEqual } from "node:crypto";

export const QR_TTL = 120_000;
const token = () => randomBytes(32).toString("base64url");
const equal = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export interface QrChallenge {
  id: string; browser: string; expiresAt: number; userAgent: string; ip: string; code: string; remember: boolean;
  sourceCookie?: string; sourceId?: string; issuedCookie?: string; busy?: boolean;
}
/** Ephemeral, bounded single-process challenges. Restarts cancel pending sign-ins. */
export class QrLogins {
  private rows = new Map<string, QrChallenge>();
  constructor(private now = Date.now, private max = 2000) {}
  create(browser: string, userAgent: string, ip: string, remember = true): QrChallenge {
    for (const [id, row] of this.rows) if (row.expiresAt <= this.now()) this.rows.delete(id);
    if (this.rows.size >= this.max) throw new Error("qr_capacity");
    const row = { id: token(), browser, remember, expiresAt: this.now() + QR_TTL, userAgent: userAgent.slice(0, 300), ip, code: randomBytes(3).toString("hex").toUpperCase() };
    this.rows.set(row.id, row); return row;
  }
  get(id: unknown): QrChallenge | null {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const row = this.rows.get(id);
    if (!row || row.expiresAt <= this.now()) { this.rows.delete(id); return null; }
    return row;
  }
  browser(id: unknown, browser: string | undefined): QrChallenge | null {
    const row = this.get(id); return row && browser && equal(row.browser, browser) ? row : null;
  }
  approve(id: unknown, sourceId: string, sourceCookie: string): boolean {
    const row = this.get(id);
    if (!row || row.issuedCookie || (row.sourceId && row.sourceId !== sourceId)) return false;
    row.sourceId = sourceId; row.sourceCookie = sourceCookie; return true;
  }
  cancel(id: unknown, browser: string | undefined): void {
    const row = this.browser(id, browser); if (row) this.rows.delete(row.id);
  }
}
export const newBrowserSecret = token;
